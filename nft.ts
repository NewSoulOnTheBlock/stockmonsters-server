// Every Stockmonster is a Metaplex Core NFT in its trainer's wallet, with
// on-chain Attributes that mirror the monster (level, stats, moves...).
//
// Who signs what:
//  - The game's update authority (data/authority.json, never leaves this
//    server) co-signs every mint and every trait update, so players can't
//    write their own traits.
//  - The player's wallet is the fee payer and signs in the browser; the
//    server never sees player keys.
// Flow: prepare (server builds + partially signs) -> wallet signs ->
// submit (server checks it's the exact transaction it built, sends, confirms).

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createNoopSigner, generateSigner, keypairIdentity, publicKey, signTransaction,
  type Signer, type TransactionBuilder, type Umi,
} from "@metaplex-foundation/umi";
import {
  create, deserializeAssetV1, fetchAsset, fetchCollection, mplCore, transfer, updatePlugin, type CollectionV1,
} from "@metaplex-foundation/mpl-core";
import { decodeMon, hexToBytes, statsAreConsistent, type MonDetails } from "./pokemon";

export const DATA_DIR = join(import.meta.dir, "data");
export const AUTHORITY_PATH = join(DATA_DIR, "authority.json");
export const NFT_CONFIG_PATH = join(DATA_DIR, "nft.json");
const OP_TTL_MS = 2 * 60_000; // a prepared transaction's blockhash expires in ~1 minute anyway

export type NftConfig = { cluster: "devnet" | "mainnet-beta"; rpcUrl: string; collection: string; publicUrl: string };

export class NftError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Production (Render) configures everything through the environment:
//   NFT_AUTHORITY_KEY  the update authority's secret key, JSON byte array (a secret!)
//   NFT_CLUSTER        devnet | mainnet-beta
//   NFT_COLLECTION     collection address
//   SOLANA_RPC_URL, PUBLIC_URL
// Locally, tools/nft-setup.ts writes data/authority.json + data/nft.json.
function authoritySecret(): Uint8Array | null {
  if (process.env.NFT_AUTHORITY_KEY) return Uint8Array.from(JSON.parse(process.env.NFT_AUTHORITY_KEY));
  if (existsSync(AUTHORITY_PATH)) return Uint8Array.from(JSON.parse(readFileSync(AUTHORITY_PATH, "utf8")));
  return null;
}

export function loadNftConfig(): NftConfig | null {
  if (process.env.NFT_AUTHORITY_KEY && process.env.NFT_COLLECTION) {
    const cluster = process.env.NFT_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";
    return {
      cluster,
      rpcUrl: process.env.SOLANA_RPC_URL ?? (cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com"),
      collection: process.env.NFT_COLLECTION,
      publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    };
  }
  if (!existsSync(NFT_CONFIG_PATH) || !existsSync(AUTHORITY_PATH)) return null;
  const saved = JSON.parse(readFileSync(NFT_CONFIG_PATH, "utf8"));
  return {
    cluster: saved.cluster,
    rpcUrl: process.env.SOLANA_RPC_URL ?? saved.rpcUrl,
    collection: saved.collection,
    publicUrl: (process.env.PUBLIC_URL ?? saved.publicUrl).replace(/\/+$/, ""),
  };
}

export function makeUmi(rpcUrl: string): Umi {
  const umi = createUmi(rpcUrl, "confirmed").use(mplCore());
  const secret = authoritySecret();
  if (!secret) throw new Error("No NFT update authority key (NFT_AUTHORITY_KEY or data/authority.json).");
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));
  return umi;
}

export function migrateNft(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_assets (
      mon_key      TEXT PRIMARY KEY,   -- personality + OT id: one NFT per individual monster
      asset        TEXT NOT NULL UNIQUE,
      owner        TEXT NOT NULL,
      species      INTEGER NOT NULL,
      details      TEXT NOT NULL,      -- JSON MonDetails as last synced on-chain
      synced_level INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS nft_assets_owner ON nft_assets(owner);
    -- Whose game currently holds each monster. The NFT owner is the truth:
    -- a copy in a non-owner's game gets removed, an owner without one gets it.
    CREATE TABLE IF NOT EXISTS game_copies (
      mon_key TEXT NOT NULL,
      wallet  TEXT NOT NULL,
      PRIMARY KEY (mon_key, wallet)
    );
  `);
  // Full 100-byte monster as last minted/synced/traded: what a buyer receives.
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(nft_assets)").all().map((c) => c.name);
  if (!cols.includes("mon_hex")) db.exec("ALTER TABLE nft_assets ADD COLUMN mon_hex TEXT");
}

// On-chain traits. Attribute values must be strings.
export function traitsFor(d: MonDetails, hometown: string | null) {
  const list: { key: string; value: string }[] = [
    { key: "Species", value: d.speciesName },
    { key: "Shiny", value: d.shiny ? "Yes" : "No" },
    { key: "Ticker", value: d.ticker ?? "-" },
    { key: "Nickname", value: d.nickname || d.speciesName },
    { key: "Level", value: String(d.level) },
    { key: "HP", value: String(d.stats[0]) },
    { key: "Attack", value: String(d.stats[1]) },
    { key: "Defense", value: String(d.stats[2]) },
    { key: "Speed", value: String(d.stats[3]) },
    { key: "Sp. Attack", value: String(d.stats[4]) },
    { key: "Sp. Defense", value: String(d.stats[5]) },
    { key: "Type", value: d.types.join(" / ") || "-" },
    { key: "Nature", value: d.nature },
    { key: "Original Trainer", value: d.otName || "-" },
  ];
  d.moves.forEach((m, i) => list.push({ key: `Move ${i + 1}`, value: m }));
  if (hometown) list.push({ key: "Hometown", value: hometown });
  return list;
}

const assetName = (d: MonDetails) => `${d.shiny ? "SHINY " : ""}${d.nickname || d.speciesName}${d.ticker ? ` (${d.ticker})` : ""}`.slice(0, 32);
const artUrl = (base: string, d: MonDetails) => `${base}/nft/art/${d.species}${d.shiny ? "s" : ""}.png`;

type PendingOp = {
  wallet: string; kind: "mint" | "sync"; monKey: string; asset: string;
  details: MonDetails; hex: string; message: Uint8Array; expires: number;
};

// One side of an in-game trade, for the NFT swap.
export type SwapSide = { wallet: string; key: string; hex: string };
export type PreparedSwap = { tx: Uint8Array; message: Uint8Array; a: SwapSide; b: SwapSide; assetA: string; assetB: string };

export function createNft(db: Database, config: NftConfig, hometownOf: (wallet: string) => string | null) {
  migrateNft(db);
  const umi = makeUmi(config.rpcUrl);
  const ops = new Map<string, PendingOp>();
  let collection: CollectionV1 | null = null;
  const getCollection = async () => (collection ??= await fetchCollection(umi, publicKey(config.collection)));

  const byKey = db.query<{ asset: string; owner: string; synced_level: number }, [string]>(
    "SELECT asset, owner, synced_level FROM nft_assets WHERE mon_key = ?");
  const byAsset = db.query<{ details: string; owner: string }, [string]>("SELECT details, owner FROM nft_assets WHERE asset = ?");
  const listOwned = db.query<{ mon_key: string; asset: string; synced_level: number }, [string]>(
    "SELECT mon_key, asset, synced_level FROM nft_assets WHERE owner = ?");
  const insert = db.query("INSERT INTO nft_assets (mon_key, asset, owner, species, details, synced_level, created_at, updated_at, mon_hex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const update = db.query("UPDATE nft_assets SET details = ?, synced_level = ?, updated_at = ?, mon_hex = ? WHERE mon_key = ?");
  const setOwner = db.query("UPDATE nft_assets SET owner = ?, updated_at = ? WHERE asset = ?");
  const setHex = db.query("UPDATE nft_assets SET mon_hex = ?, updated_at = ? WHERE mon_key = ?");
  const allAssets = db.query<{ asset: string; owner: string }, []>("SELECT asset, owner FROM nft_assets");
  const addCopy = db.query("INSERT OR IGNORE INTO game_copies (mon_key, wallet) VALUES (?, ?)");
  const dropCopy = db.query("DELETE FROM game_copies WHERE mon_key = ? AND wallet = ?");
  // Owned NFTs whose monster isn't in this wallet's game yet (bought, received).
  const deliveriesFor = db.query<{ mon_key: string; asset: string; mon_hex: string; details: string }, [string, string]>(`
    SELECT a.mon_key, a.asset, a.mon_hex, a.details FROM nft_assets a
    WHERE a.owner = ? AND a.mon_hex IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM game_copies c WHERE c.mon_key = a.mon_key AND c.wallet = ?)`);
  // Monsters in this wallet's game whose NFT now belongs to someone else (sold).
  const revocationsFor = db.query<{ mon_key: string; asset: string; details: string }, [string, string]>(`
    SELECT a.mon_key, a.asset, a.details FROM game_copies c JOIN nft_assets a ON a.mon_key = c.mon_key
    WHERE c.wallet = ? AND a.owner != ?`);

  async function sendAndConfirm(tx: Parameters<Umi["rpc"]["sendTransaction"]>[0]) {
    const signature = await umi.rpc.sendTransaction(tx);
    const blockhash = await umi.rpc.getLatestBlockhash();
    const result = await umi.rpc.confirmTransaction(signature, { strategy: { type: "blockhash", ...blockhash } });
    if (result.value.err) throw new NftError(`Transaction failed: ${JSON.stringify(result.value.err)}`, 502);
    return signature;
  }

  function decodeForWallet(hex: unknown): MonDetails {
    let d: MonDetails;
    try { d = decodeMon(hexToBytes(String(hex))); } catch (e) { throw new NftError(`Can't read that monster: ${(e as Error).message}.`); }
    if (!statsAreConsistent(d)) throw new NftError("That monster's stats don't match its level and IVs.");
    return d;
  }

  // Builds, signs with every server-side signer, and parks the transaction
  // until the player's wallet signature comes back.
  async function prepare(wallet: string, kind: PendingOp["kind"], d: MonDetails, hex: string, asset: string, builder: TransactionBuilder, extraSigners: Signer[]) {
    const payer = createNoopSigner(publicKey(wallet));
    const tx = await builder.setFeePayer(payer).buildWithLatestBlockhash(umi);
    const signed = await signTransaction(tx, [umi.identity, ...extraSigners]);
    const opId = crypto.randomUUID();
    ops.set(opId, { wallet, kind, monKey: d.key, asset, details: d, hex, message: signed.serializedMessage, expires: Date.now() + OP_TTL_MS });
    for (const [id, op] of ops) if (op.expires < Date.now()) ops.delete(id);
    return { opId, kind, asset, tx: Buffer.from(umi.transactions.serialize(signed)).toString("base64") };
  }

  return {
    config: () => ({ cluster: config.cluster, collection: config.collection }),

    ownerOf: (key: string) => byKey.get(key)?.owner ?? null,

    list(wallet: string) {
      return listOwned.all(wallet).map((r) => ({ key: r.mon_key, asset: r.asset, level: r.synced_level }));
    },

    async prepareMint(wallet: string, monHex: unknown) {
      const d = decodeForWallet(monHex);
      const existing = byKey.get(d.key);
      if (existing) throw new NftError(existing.owner === wallet ? "Already minted." : "That monster belongs to another wallet.", 409);
      const asset = generateSigner(umi);
      const payer = createNoopSigner(publicKey(wallet));
      const builder = create(umi, {
        asset,
        collection: await getCollection(),
        owner: publicKey(wallet),
        payer,
        authority: umi.identity,
        name: assetName(d),
        uri: `${config.publicUrl}/nft/meta/${asset.publicKey}.json`,
        plugins: [{ type: "Attributes", attributeList: traitsFor(d, hometownOf(wallet)) }],
      });
      return prepare(wallet, "mint", d, String(monHex).toLowerCase(), asset.publicKey.toString(), builder, [asset]);
    },

    async prepareSync(wallet: string, monHex: unknown) {
      const d = decodeForWallet(monHex);
      const row = byKey.get(d.key);
      if (!row) throw new NftError("Not minted yet.", 404);
      if (row.owner !== wallet) throw new NftError("That monster's NFT is in another wallet.", 403);
      const builder = updatePlugin(umi, {
        asset: publicKey(row.asset),
        collection: publicKey(config.collection),
        payer: createNoopSigner(publicKey(wallet)),
        authority: umi.identity,
        plugin: { type: "Attributes", attributeList: traitsFor(d, hometownOf(wallet)) },
      });
      return prepare(wallet, "sync", d, String(monHex).toLowerCase(), row.asset, builder, []);
    },

    async submit(wallet: string, body: any) {
      const op = ops.get(String(body?.opId));
      if (!op || op.wallet !== wallet) throw new NftError("That request expired; try again.", 410);
      ops.delete(String(body.opId));
      let tx;
      try { tx = umi.transactions.deserialize(Buffer.from(String(body.tx), "base64")); } catch { throw new NftError("Couldn't read the signed transaction."); }
      // The wallet may only add its signature: anything else changes the message.
      if (Buffer.compare(Buffer.from(tx.serializedMessage), Buffer.from(op.message)) !== 0)
        throw new NftError("The wallet changed the transaction; it wasn't sent.");
      const signature = await sendAndConfirm(tx);

      const now = Date.now();
      if (op.kind === "mint") {
        insert.run(op.monKey, op.asset, wallet, op.details.species, JSON.stringify(op.details), op.details.level, now, now, op.hex);
        addCopy.run(op.monKey, wallet); // it was minted from this wallet's game
      } else update.run(JSON.stringify(op.details), op.details.level, now, op.hex, op.monKey);
      return { ok: true, kind: op.kind, asset: op.asset, level: op.details.level, signature: Buffer.from(signature).toString("base64") };
    },

    // What this wallet's game should change: monsters to receive and to give up.
    inventory(wallet: string) {
      const name = (details: string) => { const d = JSON.parse(details) as MonDetails; return d.nickname || d.speciesName; };
      return {
        assets: listOwned.all(wallet).map((r) => ({ key: r.mon_key, asset: r.asset, level: r.synced_level })),
        deliveries: deliveriesFor.all(wallet, wallet).map((r) => ({ key: r.mon_key, asset: r.asset, mon: r.mon_hex, name: name(r.details) })),
        revocations: revocationsFor.all(wallet, wallet).map((r) => {
          const d = JSON.parse(r.details) as MonDetails;
          return { key: r.mon_key, asset: r.asset, personality: d.personality, otId: d.otId, name: d.nickname || d.speciesName };
        }),
      };
    },

    // The browser reports its game applied a delivery or a removal.
    markCopy(wallet: string, body: any) {
      const key = String(body?.key ?? "");
      const row = byKey.get(key);
      if (!row) throw new NftError("Unknown monster.", 404);
      if (body.action === "delivered") {
        if (row.owner !== wallet) throw new NftError("That NFT isn't yours.", 403);
        addCopy.run(key, wallet);
      } else if (body.action === "removed") {
        if (row.owner === wallet) throw new NftError("You still own that NFT.", 409);
        dropCopy.run(key, wallet);
      } else throw new NftError("Unknown action.");
      return { ok: true };
    },

    // Reads every asset's current owner from the chain (sales, transfers).
    async refreshOwners() {
      const rows = allAssets.all();
      let changed = 0;
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const accounts = await umi.rpc.getAccounts(batch.map((r) => publicKey(r.asset)));
        accounts.forEach((acc, j) => {
          if (!acc.exists) return; // burned: leave the record as it was
          const owner = deserializeAssetV1(acc).owner.toString();
          if (owner !== batch[j].owner) { setOwner.run(owner, Date.now(), batch[j].asset); changed++; }
        });
      }
      return changed;
    },

    // In-game trade: one transaction moving both NFTs, signed by both owners.
    async prepareSwap(a: SwapSide, b: SwapSide): Promise<PreparedSwap> {
      const ra = byKey.get(a.key), rb = byKey.get(b.key);
      if (!ra || !rb) throw new NftError("Both monsters have to be NFTs before they can be traded.");
      if (ra.owner !== a.wallet || rb.owner !== b.wallet) throw new NftError("One of those NFTs isn't owned by its trader anymore.");
      const [assetA, assetB, coll] = await Promise.all([fetchAsset(umi, publicKey(ra.asset)), fetchAsset(umi, publicKey(rb.asset)), getCollection()]);
      const ownerA = createNoopSigner(publicKey(a.wallet)), ownerB = createNoopSigner(publicKey(b.wallet));
      const tx = await transfer(umi, { asset: assetA, collection: coll, newOwner: publicKey(b.wallet), authority: ownerA, payer: ownerA })
        .add(transfer(umi, { asset: assetB, collection: coll, newOwner: publicKey(a.wallet), authority: ownerB, payer: ownerA }))
        .setFeePayer(ownerA)
        .buildWithLatestBlockhash(umi);
      const bytes = umi.transactions.serialize(tx);
      return { tx: bytes, message: tx.serializedMessage, a, b, assetA: ra.asset, assetB: rb.asset };
    },

    // Merges each trader's signature into the swap, sends it, records the moves.
    async finishSwap(swap: PreparedSwap, signedA: string, signedB: string) {
      const base = umi.transactions.deserialize(swap.tx);
      const read = (b64: string) => {
        const t = umi.transactions.deserialize(Buffer.from(b64, "base64"));
        if (Buffer.compare(Buffer.from(t.serializedMessage), Buffer.from(swap.message)) !== 0)
          throw new NftError("A wallet changed the trade transaction; nothing was sent.");
        return t;
      };
      const ta = read(signedA), tb = read(signedB);
      const signerIndex = (wallet: string) => base.message.accounts.findIndex((k) => k.toString() === wallet);
      const ia = signerIndex(swap.a.wallet), ib = signerIndex(swap.b.wallet);
      const signatures = base.signatures.map((s, i) => (i === ia ? ta.signatures[ia] : i === ib ? tb.signatures[ib] : s));
      await sendAndConfirm({ ...base, signatures });

      const now = Date.now();
      setOwner.run(swap.b.wallet, now, swap.assetA);
      setOwner.run(swap.a.wallet, now, swap.assetB);
      // Each game swaps its monster in the same step (trade_exec).
      dropCopy.run(swap.a.key, swap.a.wallet); addCopy.run(swap.a.key, swap.b.wallet);
      dropCopy.run(swap.b.key, swap.b.wallet); addCopy.run(swap.b.key, swap.a.wallet);
      setHex.run(swap.a.hex, now, swap.a.key);
      setHex.run(swap.b.hex, now, swap.b.key);
    },

    // Off-chain JSON the asset's uri points at: same traits, plus art.
    metadata(asset: string) {
      const row = byAsset.get(asset);
      if (!row) return null;
      const d = JSON.parse(row.details) as MonDetails;
      return {
        name: assetName(d),
        symbol: "STKMON",
        description: `${d.shiny ? "A shiny " : ""}${d.speciesName}${d.shiny ? "" : ", a Stock Monster"}. Its traits follow the monster in-game: they update every time it levels up.`,
        image: artUrl(config.publicUrl, d),
        external_url: config.publicUrl,
        attributes: traitsFor(d, hometownOf(row.owner)).map((a) => ({ trait_type: a.key, value: a.value })),
        properties: { category: "image", files: [{ uri: artUrl(config.publicUrl, d), type: "image/png" }] },
      };
    },
  };
}

export type Nft = ReturnType<typeof createNft>;
