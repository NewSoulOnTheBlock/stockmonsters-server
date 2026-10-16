// Sign-in with an Ethereum wallet. The browser asks for a nonce, has the
// wallet sign a plain-text message containing it (personal_sign; no
// transactions, no keys), and we check the signature against the address.
// Smart-contract wallets (Safe, Coinbase Smart Wallet) verify through
// ERC-1271/6492 when an RPC is configured. A good signature buys a 30-day
// session token.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http, isAddress, verifyMessage, type Hex } from "viem";

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_NAME = 10;
const MAX_MESSAGE = 512;

/** The checksummed address, or null if it isn't one. */
export function walletAddress(wallet: unknown): string | null {
  if (typeof wallet !== "string" || !isAddress(wallet, { strict: false })) return null;
  return getAddress(wallet);
}

export const shortWallet = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w);

export function loginMessage(wallet: string, nonce: string, issued: string) {
  return `Stock Monsters login\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued}`;
}
const MESSAGE_RE = /^Stock Monsters login\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{32})\nIssued: (\S+)$/;

export type VerifyFn = (address: string, message: string, signature: Hex) => Promise<boolean>;

/** EOAs locally; with an RPC, smart-contract wallets too. */
export function makeVerifier(rpcUrl?: string): VerifyFn {
  if (!rpcUrl) return (address, message, signature) =>
    verifyMessage({ address: address as Hex, message, signature }).catch(() => false);
  const client = createPublicClient({ transport: http(rpcUrl) });
  return (address, message, signature) =>
    client.verifyMessage({ address: address as Hex, message, signature }).catch(() => false);
}

// ---- profiles ---------------------------------------------------------------
export type Profile = { wallet: string; name: string; gender: number; hometown: number | null; createdAt: number };
type ProfileRow = { wallet: string; name: string | null; gender: number | null; hometown: number | null; created_at: number };

const cleanName = (v: unknown) =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);

export class AuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function createAuth(db: Database, now: () => number = Date.now, verify: VerifyFn = makeVerifier()) {
  const q = {
    putNonce: db.query("INSERT INTO nonces (nonce, wallet, expires_at) VALUES (?, ?, ?)"),
    takeNonce: db.query("DELETE FROM nonces WHERE nonce = ? AND wallet = ? AND expires_at > ? RETURNING nonce"),
    pruneNonces: db.query("DELETE FROM nonces WHERE expires_at <= ?"),
    walletNonces: db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM nonces WHERE wallet = ? AND expires_at > ?"),
    putSession: db.query("INSERT INTO sessions (token, wallet, expires_at) VALUES (?, ?, ?)"),
    getSession: db.query<{ wallet: string }, [string, number]>("SELECT wallet FROM sessions WHERE token = ? AND expires_at > ?"),
    dropSession: db.query("DELETE FROM sessions WHERE token = ?"),
    pruneSessions: db.query("DELETE FROM sessions WHERE expires_at <= ?"),
    getProfile: db.query<ProfileRow, [string]>("SELECT * FROM profiles WHERE wallet = ?"),
    newProfile: db.query("INSERT OR IGNORE INTO profiles (wallet, name, gender, hometown, created_at) VALUES (?, 'TRAINER', 0, NULL, ?)"),
    setProfile: db.query("UPDATE profiles SET name = ?, gender = ?, hometown = ? WHERE wallet = ?"),
  };

  function profile(wallet: string): Profile {
    q.newProfile.run(wallet, now());
    const r = q.getProfile.get(wallet)!;
    return { wallet: r.wallet, name: r.name || "TRAINER", gender: r.gender ?? 0, hometown: r.hometown, createdAt: r.created_at };
  }

  return {
    issueNonce(input: unknown): { nonce: string; expiresAt: number } {
      const wallet = walletAddress(input);
      if (!wallet) throw new AuthError("Not an Ethereum wallet address.");
      const t = now();
      q.pruneNonces.run(t);
      // Nonces are free to request; don't let one address fill the table.
      if (q.walletNonces.get(wallet, t)!.n >= 10) throw new AuthError("Too many pending logins; wait a few minutes.", 429);
      const nonce = randomBytes(16).toString("hex");
      const expiresAt = t + NONCE_TTL_MS;
      q.putNonce.run(nonce, wallet, expiresAt);
      return { nonce, expiresAt };
    },

    async verifyLogin(body: { wallet?: unknown; message?: unknown; signature?: unknown }) {
      const { message, signature } = body ?? {};
      const wallet = walletAddress(body?.wallet);
      if (!wallet) throw new AuthError("Not an Ethereum wallet address.");
      if (typeof message !== "string" || message.length > MAX_MESSAGE) throw new AuthError("Bad login message.");
      const m = MESSAGE_RE.exec(message);
      if (!m || getAddress(m[1]) !== wallet) throw new AuthError("Login message doesn't match this wallet.");
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) throw new AuthError("Bad signature.");
      if (!(await verify(wallet, message, signature as Hex))) throw new AuthError("Signature check failed.", 401);
      // Consume the nonce only now, atomically: a replay finds nothing to delete.
      if (!q.takeNonce.get(m[2], wallet, now())) {
        throw new AuthError("That login request expired or was already used. Try again.", 401);
      }
      const token = randomBytes(32).toString("hex");
      q.pruneSessions.run(now());
      q.putSession.run(token, wallet, now() + SESSION_TTL_MS);
      return { token, wallet, profile: profile(wallet) };
    },

    /** The wallet behind a live session token, or null. */
    sessionWallet(token: unknown): string | null {
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
      return q.getSession.get(token, now())?.wallet ?? null;
    },

    session(token: unknown) {
      const wallet = this.sessionWallet(token);
      return wallet ? { token: token as string, wallet, profile: profile(wallet) } : null;
    },

    logout(token: unknown) {
      if (typeof token === "string") q.dropSession.run(token);
    },

    getProfile: profile,

    /** Name and gender may change; hometown is set once and then kept. */
    updateProfile(wallet: string, patch: { name?: unknown; gender?: unknown; hometown?: unknown }): Profile {
      const cur = profile(wallet);
      let name = cur.name, gender = cur.gender, hometown = cur.hometown;
      if (patch?.name !== undefined) name = cleanName(patch.name) || cur.name;
      if (patch?.gender !== undefined) {
        const g = Number(patch.gender);
        if (g !== 0 && g !== 1) throw new AuthError("gender must be 0 or 1.");
        gender = g;
      }
      if (patch?.hometown !== undefined && patch.hometown !== null && hometown === null) {
        const h = Number(patch.hometown);
        if (!Number.isInteger(h) || h < 0 || h > 0xffff) throw new AuthError("hometown must be an integer 0-65535.");
        hometown = h;
      }
      q.setProfile.run(name, gender, hometown, wallet);
      return profile(wallet);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

export const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
