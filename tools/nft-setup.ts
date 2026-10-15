// One-time NFT setup: creates the game's update-authority key (if missing)
// and the "Stock Monsters" Metaplex Core collection.
//
//   bun run tools/nft-setup.ts devnet  [publicUrl]
//   bun run tools/nft-setup.ts mainnet [publicUrl]     (SOLANA_RPC_URL recommended)
//
// The authority only pays the collection's one-time rent (~0.002 SOL); players
// pay for their own mints and trait updates. On devnet it airdrops itself.
// The key stays in data/authority.json: back it up, never commit or share it.

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, sol } from "@metaplex-foundation/umi";
import { createCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { AUTHORITY_PATH, DATA_DIR, NFT_CONFIG_PATH, loadNftConfig, makeUmi } from "../nft";

const cluster = process.argv[2] === "mainnet" ? "mainnet-beta" : "devnet";
const publicUrl = (process.argv[3] ?? process.env.PUBLIC_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
const rpcUrl = process.env.SOLANA_RPC_URL ?? (cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(AUTHORITY_PATH)) {
  const kp = createUmi(rpcUrl).eddsa.generateKeypair();
  writeFileSync(AUTHORITY_PATH, JSON.stringify(Array.from(kp.secretKey)));
  try { chmodSync(AUTHORITY_PATH, 0o600); } catch {}
  console.log("Created a new update-authority key at", AUTHORITY_PATH);
}

const existing = loadNftConfig();
if (existing?.cluster === cluster) {
  console.log(`Already set up on ${cluster}: collection ${existing.collection}`);
  process.exit(0);
}

const umi = makeUmi(rpcUrl);
console.log(`Authority: ${umi.identity.publicKey} on ${cluster}`);

let balance = await umi.rpc.getBalance(umi.identity.publicKey);
if (balance.basisPoints < sol(0.005).basisPoints) {
  if (cluster !== "devnet") {
    console.log(`Send ~0.01 SOL to ${umi.identity.publicKey} to pay the collection's rent, then rerun.`);
    process.exit(1);
  }
  console.log("Requesting a devnet airdrop…");
  await umi.rpc.airdrop(umi.identity.publicKey, sol(0.1));
  balance = await umi.rpc.getBalance(umi.identity.publicKey);
}
console.log(`Balance: ${Number(balance.basisPoints) / 1e9} SOL`);

const collection = generateSigner(umi);
await createCollection(umi, {
  collection,
  name: "Stock Monsters",
  uri: `${publicUrl}/nft/collection.json`,
}).sendAndConfirm(umi);

writeFileSync(NFT_CONFIG_PATH, JSON.stringify({ cluster, rpcUrl, collection: collection.publicKey.toString(), publicUrl }, null, 2));
console.log(`Collection ${collection.publicKey} created on ${cluster}. Saved ${NFT_CONFIG_PATH}`);
