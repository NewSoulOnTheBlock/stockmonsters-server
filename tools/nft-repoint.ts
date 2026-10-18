// Points the collection and every minted asset at a new public URL (their
// metadata `uri`), e.g. after moving the server from localhost to production.
// Signed and paid for by the update authority (~0.000005 SOL per asset).
//
//   PUBLIC_URL=https://stockmonsters-server.onrender.com bun run tools/nft-repoint.ts [--dry-run]

import { Database } from "bun:sqlite";
import { publicKey } from "@metaplex-foundation/umi";
import { fetchAsset, fetchCollection, update, updateCollection } from "@metaplex-foundation/mpl-core";
import { DEFAULT_DB_PATH } from "../db";
import { loadNftConfig, makeUmi } from "../nft";

const base = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) throw new Error("Set PUBLIC_URL to the production https URL.");
const dry = process.argv.includes("--dry-run");
const config = loadNftConfig();
if (!config) throw new Error("No NFT config.");
const umi = makeUmi(config.rpcUrl);

const collection = await fetchCollection(umi, publicKey(config.collection));
const collUri = `${base}/nft/collection.json`;
if (collection.uri !== collUri) {
  console.log(`collection: ${collection.uri} -> ${collUri}`);
  if (!dry) await updateCollection(umi, { collection: collection.publicKey, newUri: collUri }).sendAndConfirm(umi);
}

const db = new Database(process.env.DB_PATH ?? DEFAULT_DB_PATH, { readonly: true });
const assets = db.query<{ asset: string }, []>("SELECT asset FROM nft_assets").all();
for (const { asset } of assets) {
  const a = await fetchAsset(umi, publicKey(asset));
  const uri = `${base}/nft/meta/${asset}.json`;
  if (a.uri === uri) continue;
  console.log(`${a.name}: ${a.uri} -> ${uri}`);
  if (!dry) await update(umi, { asset: a, collection, uri }).sendAndConfirm(umi);
}
console.log(dry ? "dry run: nothing sent" : "done");
