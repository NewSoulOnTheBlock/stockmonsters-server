import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { base58Decode, createAuth, loginMessage, NONCE_TTL_MS, shortWallet, walletKey } from "../auth";
import { openDb } from "../db";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Test-only encoder (the server only ever decodes).
function base58Encode(bytes: Uint8Array) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { address: base58Encode(raw), signText: (msg: string) => sign(null, Buffer.from(msg), privateKey).toString("base64") };
}

function setup() {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { auth: createAuth(openDb(":memory:"), clock.now), clock };
}

function login(auth: ReturnType<typeof setup>["auth"], w = newWallet()) {
  const { nonce } = auth.issueNonce(w.address);
  const message = loginMessage(w.address, nonce, new Date().toISOString());
  return { w, nonce, message, signature: w.signText(message) };
}

describe("base58", () => {
  test("round-trips random keys and leading zeros", () => {
    for (let i = 0; i < 200; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      if (i % 10 === 0) bytes[0] = 0, bytes[1] = 0;
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });
  test("decodes the system program and rejects junk", () => {
    expect(base58Decode("11111111111111111111111111111111")).toEqual(new Uint8Array(32));
    expect(() => base58Decode("0OIl")).toThrow();
    expect(walletKey("not-a-wallet")).toBeNull();
    expect(walletKey("So11111111111111111111111111111111111111112")?.length).toBe(32);
  });
  test("short wallet", () => {
    expect(shortWallet("So11111111111111111111111111111111111111112")).toBe("So11…1112");
  });
});

describe("login", () => {
  test("a correctly signed message logs in and the token works", () => {
    const { auth } = setup();
    const l = login(auth);
    const res = auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: l.signature });
    expect(res.wallet).toBe(l.w.address);
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.profile).toMatchObject({ wallet: l.w.address, name: "TRAINER", gender: 0, hometown: null });
    expect(auth.session(res.token)?.wallet).toBe(l.w.address);
    auth.logout(res.token);
    expect(auth.session(res.token)).toBeNull();
  });

  test("a tampered message fails", () => {
    const { auth } = setup();
    const l = login(auth);
    const tampered = l.message.replace(/Issued: .*/, "Issued: 1999-01-01T00:00:00.000Z");
    expect(() => auth.verifyLogin({ wallet: l.w.address, message: tampered, signature: l.signature })).toThrow("Signature");
    // Another wallet's signature over the right message also fails.
    const other = newWallet();
    expect(() => auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: other.signText(l.message) })).toThrow("Signature");
    // Claiming the message for a different wallet fails before any signature check.
    expect(() => auth.verifyLogin({ wallet: other.address, message: l.message, signature: l.signature })).toThrow("match");
  });

  test("a reused nonce fails", () => {
    const { auth } = setup();
    const l = login(auth);
    const body = { wallet: l.w.address, message: l.message, signature: l.signature };
    auth.verifyLogin(body);
    expect(() => auth.verifyLogin(body)).toThrow("already used");
  });

  test("an expired nonce fails", () => {
    const { auth, clock } = setup();
    const l = login(auth);
    clock.advance(NONCE_TTL_MS + 1);
    expect(() => auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: l.signature })).toThrow("expired");
  });

  test("a nonce issued to one wallet can't be used by another", () => {
    const { auth } = setup();
    const a = newWallet(), b = newWallet();
    const { nonce } = auth.issueNonce(a.address);
    const message = loginMessage(b.address, nonce, new Date().toISOString());
    expect(() => auth.verifyLogin({ wallet: b.address, message, signature: b.signText(message) })).toThrow("expired");
  });

  test("sessions expire after 30 days", () => {
    const { auth, clock } = setup();
    const l = login(auth);
    const { token } = auth.verifyLogin({ wallet: l.w.address, message: l.message, signature: l.signature });
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
