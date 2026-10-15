// "The NFT is the monster" check, against a running server on the configured
// cluster. Two scripted wallets: B (the authority key, playing as a player)
// and P (data/test-player.json).
//   1. B mints M1, then sells it to P with a plain on-chain transfer
//      (what a marketplace does). Server must tell B's game to remove M1 and
//      P's game to receive it.
//   2. B mints M2; P and B trade M1 <-> M2 through the real WebSocket trade:
//      both wallets sign one swap transaction; owners must flip on-chain.
//
//   bun run tools/market-e2e.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, publicKey, signTransaction, type Keypair, type Umi } from "@metaplex-foundation/umi";
import { fetchAsset, fetchCollection, mplCore, transfer } from "@metaplex-foundation/mpl-core";
import { AUTHORITY_PATH, DATA_DIR, loadNftConfig } from "../nft";
import { decodeMon, expectedStats } from "../pokemon";
import { craftMon } from "./craft-mon";

const BASE = process.env.SERVER ?? "http://127.0.0.1:8642";
const config = loadNftConfig()!;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`ok - ${what}`); };

function player(path: string) {
  const umi = createUmi(config.rpcUrl, "confirmed").use(mplCore());
  const kp = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  umi.use(keypairIdentity(kp));
  return { umi, kp, wallet: kp.publicKey.toString(), token: "" };
}
type P = ReturnType<typeof player>;
const B = player(AUTHORITY_PATH), Pl = player(join(DATA_DIR, "test-player.json"));

async function call(p: P, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out: any = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${out.error}`);
  return out;
}
async function login(p: P) {
  const { nonce } = await call(p, `/auth/nonce?wallet=${p.wallet}`);
  const message = `Stock Monsters login\nWallet: ${p.wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
  const sig = await p.umi.eddsa.sign(new TextEncoder().encode(message), p.kp);
  p.token = (await call(p, "/auth/verify", { wallet: p.wallet, message, signature: b64(sig) })).token;
}
function consistentMon(species: number, level: number, nick: string, otId: number) {
  const bytes = craftMon(species, level, nick, (Math.random() * 2 ** 32) >>> 0, otId);
  const stats = expectedStats(decodeMon(bytes))!;
  const dv = new DataView(bytes.buffer);
  dv.setUint16(86, stats[0], true);
  stats.forEach((v, i) => dv.setUint16(88 + i * 2, v, true));
  return Buffer.from(bytes).toString("hex");
}
async function mint(p: P, hex: string) {
  const op = await call(p, "/nft/prepare-mint", { mon: hex });
  const signed = await signTransaction(p.umi.transactions.deserialize(Buffer.from(op.tx, "base64")), [p.umi.identity]);
  return (await call(p, "/nft/submit", { opId: op.opId, tx: b64(p.umi.transactions.serialize(signed)) })).asset as string;
}
const ownerOf = async (umi: Umi, asset: string) => (await fetchAsset(umi, publicKey(asset))).owner.toString();

await login(B); await login(Pl);
console.log(`B ${B.wallet}\nP ${Pl.wallet}`);

// ---- 1. marketplace sale: B -> P -------------------------------------------
const m1hex = consistentMon(25, 7, "SALEBOLT", 0xb0b0b0b0);
const m1Key = decodeMon(Buffer.from(m1hex, "hex")).key;
const m1 = await mint(B, m1hex);
console.log("B minted M1", m1);
const coll = await fetchCollection(B.umi, publicKey(config.collection));
await transfer(B.umi, { asset: await fetchAsset(B.umi, publicKey(m1)), collection: coll, newOwner: publicKey(Pl.wallet) }).sendAndConfirm(B.umi);
console.log("B sold M1 to P (plain on-chain transfer)");

const invB = await call(B, "/nft/mine"), invP = await call(Pl, "/nft/mine"); // forces an owner refresh
check(invB.revocations.some((r: any) => r.key === m1Key), "seller's game is told to remove M1");
const delivery = invP.deliveries.find((d: any) => d.key === m1Key);
check(delivery && delivery.mon === m1hex, "buyer's game is told to receive M1, byte-for-byte");
await call(B, "/nft/copy", { key: m1Key, action: "removed" });
await call(Pl, "/nft/copy", { key: m1Key, action: "delivered" });
const after = [await call(B, "/nft/mine"), await call(Pl, "/nft/mine")];
check(!after[0].revocations.length && !after[1].deliveries.some((d: any) => d.key === m1Key), "both games settled");
let refused = false;
try { await call(B, "/nft/copy", { key: m1Key, action: "delivered" }); } catch { refused = true; }
check(refused, "seller can't claim M1 back into their game");

// ---- 2. in-game trade swaps the NFTs ---------------------------------------
const m2hex = consistentMon(7, 7, "SWAPZAR", 0xb0b0b0b0);
const m2 = await mint(B, m2hex);
console.log("B minted M2", m2);

function socket(p: P) {
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
  const inbox: any[] = [];
  const waiters: { t: string; resolve: (m: any) => void }[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.findIndex((x) => x.t === m.t);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m);
  };
  const next = (t: string) => {
    const i = inbox.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise<any>((resolve, reject) => { waiters.push({ t, resolve }); setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 90_000); });
  };
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, next, send, open: new Promise((r) => (ws.onopen = r)) };
}
const sb = socket(B), sp = socket(Pl);
await Promise.all([sb.open, sp.open]);
const welcomeB = await sb.next("welcome"), welcomeP = await sp.next("welcome");
sb.send({ t: "hello", token: B.token, name: "BUYER", gender: 0 });
sp.send({ t: "hello", token: Pl.token, name: "PLAYER", gender: 0 });
for (const s of [sb, sp]) s.send({ t: "pos", g: 3, n: 0, x: 10, y: 10, f: 1, e: 3, gfx: 0 });
await new Promise((r) => setTimeout(r, 300));

sb.send({ t: "trade_request", to: welcomeP.id });
const req = await sp.next("trade_request");
sp.send({ t: "trade_respond", from: req.from, accept: true });
await Promise.all([sb.next("trade_open"), sp.next("trade_open")]);
sb.send({ t: "trade_offer", slot: 0, mon: m2hex });
sp.send({ t: "trade_offer", slot: 0, mon: m1hex });
await new Promise((r) => setTimeout(r, 300));
sb.send({ t: "trade_confirm" });
sp.send({ t: "trade_confirm" });

async function signSwap(p: P, s: ReturnType<typeof socket>) {
  const m = await s.next("trade_sign");
  const signed = await signTransaction(p.umi.transactions.deserialize(Buffer.from(m.tx, "base64")), [p.umi.identity]);
  s.send({ t: "trade_signed", tx: b64(p.umi.transactions.serialize(signed)) });
}
await Promise.all([signSwap(B, sb), signSwap(Pl, sp)]);
const [execB, execP] = await Promise.all([sb.next("trade_exec"), sp.next("trade_exec")]);
check(execB.receive === m1hex && execP.receive === m2hex, "after the NFT swap, each game is told to swap monsters");
sb.send({ t: "trade_result", ok: true }); sp.send({ t: "trade_result", ok: true });
const closed = await sb.next("trade_closed");
check(closed.reason === "complete", "trade completes");
check((await ownerOf(B.umi, m1)) === B.wallet && (await ownerOf(B.umi, m2)) === Pl.wallet, "on-chain: M1 is B's again, M2 is P's");
const settle = [await call(B, "/nft/mine"), await call(Pl, "/nft/mine")];
check(!settle[0].revocations.length && !settle[0].deliveries.length && !settle[1].revocations.length && !settle[1].deliveries.length,
  "no stray deliveries or removals after the trade");
sb.ws.close(); sp.ws.close();
console.log("MARKET E2E OK", { welcomeB: welcomeB.id });
process.exit(0);
