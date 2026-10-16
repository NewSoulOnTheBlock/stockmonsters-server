import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAuth, loginMessage, makeVerifier, NONCE_TTL_MS, shortWallet, walletAddress } from "../auth";
import { openDb } from "../db";

function newWallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  return { address: account.address as string, signText: (msg: string) => account.signMessage({ message: msg }) };
}

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { auth: createAuth(openDb(":memory:"), clock.now, makeVerifier()), clock };
}

async function login(auth: ReturnType<typeof setup>["auth"], w = newWallet()) {
  const { nonce } = auth.issueNonce(w.address);
  const message = loginMessage(w.address, nonce, new Date().toISOString());
  return { w, nonce, message, signature: await w.signText(message) };
}

describe("addresses", () => {
  test("checksums any casing and rejects junk", () => {
    const w = newWallet().address;
    expect(walletAddress(w.toLowerCase())).toBe(w);
    expect(walletAddress(w.toUpperCase().replace("0X", "0x"))).toBe(w);
    expect(walletAddress("not-a-wallet")).toBeNull();
    expect(walletAddress("So11111111111111111111111111111111111111112")).toBeNull(); // Solana: no longer accepted
    expect(walletAddress(42)).toBeNull();
  });
  test("short wallet", () => {
    expect(shortWallet("0x1b05d9458cbe691127a3f0de4f546aa32de7ffff")).toBe("0x1b05…ffff");
  });
});

describe("login", () => {
  test("a correctly signed message logs in and the token works", async () => {
    const { auth } = setup();
    const l = await login(auth);
    const res = await auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: l.signature });
    expect(res.wallet).toBe(l.w.address);
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.profile).toMatchObject({ wallet: l.w.address, name: "TRAINER", gender: 0, hometown: null });
    expect(auth.session(res.token)?.wallet).toBe(l.w.address);
    auth.logout(res.token);
    expect(auth.session(res.token)).toBeNull();
  });

  test("a lowercase address from the wallet maps to the same account", async () => {
    const { auth } = setup();
    const w = newWallet();
    const lower = w.address.toLowerCase();
    const { nonce } = auth.issueNonce(lower);
    const message = loginMessage(lower, nonce, new Date().toISOString());
    const res = await auth.verifyLogin({ wallet: lower, message, signature: await w.signText(message) });
    expect(res.wallet).toBe(w.address);
  });

  test("a tampered message fails", async () => {
    const { auth } = setup();
    const l = await login(auth);
    const tampered = l.message.replace(/Issued: .*/, "Issued: 1999-01-01T00:00:00.000Z");
    await expect(auth.verifyLogin({ wallet: l.w.address, message: tampered, signature: l.signature })).rejects.toThrow("Signature");
    // Another wallet's signature over the right message also fails.
    const other = newWallet();
    await expect(auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: await other.signText(l.message) })).rejects.toThrow("Signature");
    // Claiming the message for a different wallet fails before any signature check.
    await expect(auth.verifyLogin({ wallet: other.address, message: l.message, signature: l.signature })).rejects.toThrow("match");
  });

  test("a reused nonce fails", async () => {
    const { auth } = setup();
    const l = await login(auth);
    const body = { wallet: l.w.address, message: l.message, signature: l.signature };
    await auth.verifyLogin(body);
    await expect(auth.verifyLogin(body)).rejects.toThrow("already used");
  });

  test("an expired nonce fails", async () => {
    const { auth, clock } = setup();
    const l = await login(auth);
    clock.advance(NONCE_TTL_MS + 1);
    await expect(auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: l.signature })).rejects.toThrow("expired");
  });

  test("a nonce issued to one wallet can't be used by another", async () => {
    const { auth } = setup();
    const a = newWallet(), b = newWallet();
    const { nonce } = auth.issueNonce(a.address);
    const message = loginMessage(b.address, nonce, new Date().toISOString());
    await expect(auth.verifyLogin({ wallet: b.address, message, signature: await b.signText(message) })).rejects.toThrow("expired");
  });

  test("garbage signatures are rejected", async () => {
    const { auth } = setup();
    const l = await login(auth);
    await expect(auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: "nope" })).rejects.toThrow("Bad signature");
  });

  test("sessions expire after 30 days", async () => {
    const { auth, clock } = setup();
    const l = await login(auth);
    const { token } = await auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: l.signature });
    clock.advance(29 * 86_400_000);
    expect(auth.sessionWallet(token)).toBe(l.w.address);
    clock.advance(2 * 86_400_000);
    expect(auth.sessionWallet(token)).toBeNull();
  });
});

describe("profile", () => {
  test("hometown is write-once; name and gender update", () => {
    const { auth } = setup();
    const w = newWallet().address;
    expect(auth.updateProfile(w, { name: "ASH", gender: 1 })).toMatchObject({ name: "ASH", gender: 1, hometown: null });
    expect(auth.updateProfile(w, { hometown: 3 }).hometown).toBe(3);
    const after = auth.updateProfile(w, { hometown: 7, name: "RED", gender: 0 });
    expect(after).toMatchObject({ name: "RED", gender: 0, hometown: 3 });
    expect(auth.getProfile(w).hometown).toBe(3);
    expect(() => auth.updateProfile(w, { gender: 5 })).toThrow();
    expect(auth.updateProfile(w, { name: "A-VERY-LONG-NAME" }).name).toBe("A-VERY-LON");
  });
});
