// End-to-end NFT check against a running server (default http://127.0.0.1:8642)
// on devnet, playing the browser's part with a throwaway "player" keypair:
// login -> mint a monster -> level it up -> sync -> read traits back on-chain.
//
//   bun run tools/nft-e2e.ts            (prints the test player's address to fund)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, publicKey, signTransaction } from "@metaplex-foundation/umi";
import { fetchAsset, mplCore } from "@metaplex-foundation/mpl-core";
import { DATA_DIR, loadNftConfig } from "../nft";
import { decodeMon, expectedStats } from "../pokemon";
import { craftMon } from "./craft-mon";

const BASE = process.env.SERVER ?? "http://127.0.0.1:8642";
const config = loadNftConfig();
if (!config) throw new Error("Run tools/nft-setup.ts devnet first.");

const umi = createUmi(config.rpcUrl, "confirmed").use(mplCore());
const playerPath = join(DATA_DIR, "test-player.json");
if (!existsSync(playerPath)) writeFileSync(playerPath, JSON.stringify(Array.from(umi.eddsa.generateKeypair().secretKey)));
const player = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(readFileSync(playerPath, "utf8"))));
umi.use(keypairIdentity(player));
const wallet = player.publicKey.toString();
const lamports = Number((await umi.rpc.getBalance(player.publicKey)).basisPoints);
console.log(`test player ${wallet}: ${lamports / 1e9} SOL`);
if (lamports < 10_000_000) { console.log("Fund it with ~0.05 devnet SOL (faucet.solana.com), then rerun."); process.exit(1); }

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out: any = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${out.error}`);
  return out;
}

// Login exactly like login.js does, signing with the keypair.
const { nonce } = await call(`/auth/nonce?wallet=${wallet}`);
const message = `Stock Monsters login\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
const sig = await umi.eddsa.sign(new TextEncoder().encode(message), player);
const { token } = await call("/auth/verify", { wallet, message, signature: b64(sig) });
console.log("logged in");

// A monster whose party stats match the Gen 3 formula, like the game writes.
function consistentMon(level: number, personality: number) {
  const bytes = craftMon(7, level, "TESTLAZAR", personality);
  const stats = expectedStats(decodeMon(bytes) as any)!;
  const dv = new DataView(bytes.buffer);
  bytes[84] = level;
  dv.setUint16(86, stats[0], true);
  stats.forEach((v, i) => dv.setUint16(88 + i * 2, v, true));
  return Buffer.from(bytes).toString("hex");
}

async function signAndSubmit(op: any) {
  const tx = umi.transactions.deserialize(Buffer.from(op.tx, "base64"));
  const signed = await signTransaction(tx, [umi.identity]); // the wallet's part
  return call("/nft/submit", { opId: op.opId, tx: b64(umi.transactions.serialize(signed)) }, token);
}

const personality = (Math.random() * 2 ** 32) >>> 0;
const mint = await call("/nft/prepare-mint", { mon: consistentMon(5, personality) }, token);
const minted = await signAndSubmit(mint);
console.log("minted", minted.asset);

const sync = await call("/nft/prepare-sync", { mon: consistentMon(6, personality) }, token);
await signAndSubmit(sync);
console.log("synced to Lv 6");

const asset = await fetchAsset(umi, publicKey(minted.asset));
const attrs = Object.fromEntries(asset.attributes!.attributeList.map((a) => [a.key, a.value]));
console.log("on-chain owner:", asset.owner.toString() === wallet ? "player wallet" : asset.owner.toString());
console.log("on-chain traits:", attrs);
if (attrs.Level !== "6") throw new Error("level did not sync on-chain");

// The guard: a wallet can't mint the same monster twice.
try { await call("/nft/prepare-mint", { mon: consistentMon(6, personality) }, token); throw new Error("double mint allowed!"); }
catch (e) { if (!/Already minted/.test(String(e))) throw e; console.log("double mint refused"); }

const meta = await (await fetch(`${BASE}/nft/meta/${minted.asset}.json`)).json();
console.log("metadata:", meta.name, meta.image);
console.log("E2E OK");
