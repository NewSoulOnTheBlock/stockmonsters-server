// Sign-in with a Solana wallet. The browser asks for a nonce, has the wallet
// sign a plain-text message containing it (signMessage only; no transactions,
// no keys), and we check the ed25519 signature against the wallet address.
// A good signature buys a 30-day session token.

import type { Database } from "bun:sqlite";
import { createPublicKey, randomBytes, verify } from "node:crypto";

export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_NAME = 10;
const MAX_MESSAGE = 512;

// ---- base58 (Bitcoin alphabet, as Solana uses) -----------------------------
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  if (typeof s !== "string" || !s) throw new Error("empty base58");
  const bytes: number[] = []; // little-endian base-256 accumulator
  for (const c of s) {
    const v = ALPHABET_MAP.get(c);
    if (v === undefined) throw new Error("bad base58 character");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Each leading '1' is a leading zero byte.
  for (const c of s) { if (c !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

/** The 32-byte ed25519 public key for a wallet address, or null if it isn't one. */
export function walletKey(wallet: unknown): Uint8Array | null {
  if (typeof wallet !== "string" || wallet.length < 32 || wallet.length > 44) return null;
  try {
    const k = base58Decode(wallet);
    return k.length === 32 ? k : null;
  } catch { return null; }
}

export const shortWallet = (w: string) => (w.length > 8 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

export function loginMessage(wallet: string, nonce: string, issued: string) {
  return `Stock Monsters login\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued}`;
}
const MESSAGE_RE = /^Stock Monsters login\nWallet: (\S+)\nNonce: ([0-9a-f]{32})\nIssued: (\S+)$/;

export function verifyEd25519(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (pubkey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubkey).toString("base64url") },
      format: "jwk",
    });
    return verify(null, message, key, signature);
  } catch { return false; }
}

function decodeSignature(sig: unknown): Uint8Array | null {
  if (typeof sig !== "string" || sig.length > 128) return null;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) {
    const b = Buffer.from(sig, "base64");
    if (b.length === 64) return new Uint8Array(b);
  }
  try { const b = base58Decode(sig); return b.length === 64 ? b : null; } catch { return null; }
}

// ---- profiles ---------------------------------------------------------------
export type Profile = { wallet: string; name: string; gender: number; hometown: number | null; createdAt: number };
type ProfileRow = { wallet: string; name: string | null; gender: number | null; hometown: number | null; created_at: number };

const cleanName = (v: unknown) =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);

export class AuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function createAuth(db: Database, now: () => number = Date.now) {
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
    issueNonce(wallet: unknown): { nonce: string; expiresAt: number } {
      if (!walletKey(wallet)) throw new AuthError("Not a Solana wallet address.");
      const t = now();
      q.pruneNonces.run(t);
      // Nonces are free to request; don't let one address fill the table.
      if (q.walletNonces.get(wallet as string, t)!.n >= 10) throw new AuthError("Too many pending logins; wait a few minutes.", 429);
      const nonce = randomBytes(16).toString("hex");
      const expiresAt = t + NONCE_TTL_MS;
      q.putNonce.run(nonce, wallet as string, expiresAt);
      return { nonce, expiresAt };
    },

    verifyLogin(body: { wallet?: unknown; message?: unknown; signature?: unknown }) {
      const { wallet, message, signature } = body ?? {};
      const key = walletKey(wallet);
      if (!key) throw new AuthError("Not a Solana wallet address.");
      if (typeof message !== "string" || message.length > MAX_MESSAGE) throw new AuthError("Bad login message.");
      const m = MESSAGE_RE.exec(message);
      if (!m || m[1] !== wallet) throw new AuthError("Login message doesn't match this wallet.");
      const sig = decodeSignature(signature);
      if (!sig || !verifyEd25519(key, new TextEncoder().encode(message), sig)) {
        throw new AuthError("Signature check failed.", 401);
      }
      // Consume the nonce only now, atomically: a replay finds nothing to delete.
      if (!q.takeNonce.get(m[2], wallet as string, now())) {
        throw new AuthError("That login request expired or was already used. Try again.", 401);
      }
      const token = randomBytes(32).toString("hex");
      q.pruneSessions.run(now());
      q.putSession.run(token, wallet as string, now() + SESSION_TTL_MS);
      return { token, wallet: wallet as string, profile: profile(wallet as string) };
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
