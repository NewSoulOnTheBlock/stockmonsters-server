// Every Stockmonster is an ERC-721 token (contracts/StockMonsters.sol) in its
// trainer's Ethereum wallet. Token id = (personality << 32) | OT id, the same
// identity the game uses, so one NFT per individual monster.
//
// Who signs what:
//  - The game's voucher key (NFT_SIGNER_KEY / data/signer.json, never leaves
//    this server) signs an EIP-712 Mint voucher for a monster it has checked.
//    It holds no ETH and can't move anyone's tokens.
//  - The player's wallet sends mint(tokenId, deadline, voucher) and pays gas.
//  - Traits are off-chain JSON at tokenURI, served from here, so a level-up
//    is just a database update: no transaction, no gas.
//  - Trades: the partner signs an EIP-712 Swap (free); the player who asked
//    for the trade sends swap(...) and pays the gas.
// The server never sees player keys, and only records a mint or swap after
// reading its receipt from the chain.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, encodeFunctionData, getAddress, http, parseAbi, parseEventLogs, zeroAddress,
  type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { decodeMon, hexToBytes, statsAreConsistent, type MonDetails } from "./pokemon";

export const DATA_DIR = join(import.meta.dir, "data");
export const SIGNER_PATH = join(DATA_DIR, "signer.json");
export const NFT_CONFIG_PATH = join(DATA_DIR, "nft-eth.json");
const VOUCHER_TTL_S = 30 * 60;  // a mint voucher is good for 30 minutes
const SWAP_TTL_S = 10 * 60;     // a signed swap for 10
const RECEIPT_TIMEOUT_MS = 180_000;

export const ABI = parseAbi([
  "function mint(uint256 tokenId, uint256 deadline, bytes signature)",
  "function swap(uint256 give, uint256 get, uint256 deadline, bytes signature)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function swapNonce(address owner) view returns (uint256)",
  "function signer() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Swapped(uint256 indexed tokenA, uint256 indexed tokenB, address a, address b)",
]);

export type NftConfig = { chainId: number; rpcUrl: string; contract: Hex; publicUrl: string };

export class NftError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Production configures everything through the environment:
//   NFT_SIGNER_KEY   the voucher key, 0x-hex private key (a secret, but holds no funds)
//   NFT_CONTRACT     the deployed StockMonsters address
//   ETH_RPC_URL      Ethereum RPC (a paid one is recommended)
//   NFT_CHAIN_ID     1 = mainnet (default)
//   PUBLIC_URL       where /nft/meta is served, e.g. https://www.stockmonsters.app
// Locally, tools/nft-setup.ts writes data/signer.json + data/nft-eth.json.
export function signerKey(): Hex | null {
  if (process.env.NFT_SIGNER_KEY) return process.env.NFT_SIGNER_KEY as Hex;
  if (existsSync(SIGNER_PATH)) return JSON.parse(readFileSync(SIGNER_PATH, "utf8")).privateKey as Hex;
  return null;
}

export const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

export function loadNftConfig(): NftConfig | null {
  if (!signerKey()) return null;
  if (process.env.NFT_CONTRACT) {
    return {
      chainId: Number(process.env.NFT_CHAIN_ID ?? 1),
      rpcUrl: process.env.ETH_RPC_URL ?? DEFAULT_RPC,
      contract: getAddress(process.env.NFT_CONTRACT),
      publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    };
  }
  if (!existsSync(NFT_CONFIG_PATH)) return null;
  const saved = JSON.parse(readFileSync(NFT_CONFIG_PATH, "utf8"));
  return {
    chainId: Number(saved.chainId),
    rpcUrl: process.env.ETH_RPC_URL ?? saved.rpcUrl,
    contract: getAddress(saved.contract),
    publicUrl: (process.env.PUBLIC_URL ?? saved.publicUrl).replace(/\/+$/, ""),
  };
}

export const tokenIdOf = (monKey: string) => BigInt("0x" + monKey);

export function migrateNft(db: Database) {
  // Fresh tables for Ethereum; the Solana-era nft_assets/game_copies are left alone.
  db.exec(`
    CREATE TABLE IF NOT EXISTS eth_nfts (
      mon_key      TEXT PRIMARY KEY,   -- personality + OT id; token id = 0x<mon_key>
      token_id     TEXT NOT NULL UNIQUE,
      owner        TEXT NOT NULL,      -- checksummed address
      species      INTEGER NOT NULL,
      details      TEXT NOT NULL,      -- JSON MonDetails as last synced
      synced_level INTEGER NOT NULL,
      mon_hex      TEXT,               -- full 100-byte monster: what a new owner receives
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS eth_nfts_owner ON eth_nfts(owner);
    -- Whose game currently holds each monster. The NFT owner is the truth:
    -- a copy in a non-owner's game gets removed, an owner without one gets it.
    CREATE TABLE IF NOT EXISTS eth_game_copies (
      mon_key TEXT NOT NULL,
      wallet  TEXT NOT NULL,
      PRIMARY KEY (mon_key, wallet)
    );
  `);
}

// Marketplace traits. Values are strings for display.
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

const assetName = (d: MonDetails) => `${d.shiny ? "SHINY " : ""}${d.nickname || d.speciesName}${d.ticker ? ` (${d.ticker})` : ""}`;
const artUrl = (base: string, d: MonDetails) => `${base}/nft/art/${d.species}${d.shiny ? "s" : ""}.png`;

type PendingMint = { wallet: string; monKey: string; tokenId: bigint; details: MonDetails; hex: string; expires: number };

// One side of an in-game trade. `a` asked for the trade: they send the swap and pay gas.
export type SwapSide = { wallet: string; key: string; hex: string };
export type PreparedSwap = {
  a: SwapSide; b: SwapSide; tokenA: bigint; tokenB: bigint; nonce: bigint; deadline: bigint;
  typedData: ReturnType<typeof swapTypedData>; // what b signs
  signature?: Hex;
};

const DOMAIN_TYPE = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] as const;
const MINT_TYPES = { Mint: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;
const SWAP_TYPES = { Swap: [{ name: "give", type: "uint256" }, { name: "get", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;

const domainOf = (c: NftConfig) => ({ name: "Stock Monsters", version: "1", chainId: c.chainId, verifyingContract: c.contract });

/** EIP-712 payload in wallet-ready JSON (eth_signTypedData_v4): numbers as strings. */
function swapTypedData(c: NftConfig, give: bigint, get: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: domainOf(c),
    types: { EIP712Domain: DOMAIN_TYPE, ...SWAP_TYPES },
    primaryType: "Swap" as const,
    message: { give: give.toString(), get: get.toString(), nonce: nonce.toString(), deadline: deadline.toString() },
  };
}

const nowS = () => BigInt(Math.floor(Date.now() / 1000));

export function createNft(db: Database, config: NftConfig, hometownOf: (wallet: string) => string | null, opts: { client?: PublicClient } = {}) {
  migrateNft(db);
  const key = signerKey();
  if (!key) throw new Error("No NFT voucher key (NFT_SIGNER_KEY or data/signer.json).");
  const signer: PrivateKeyAccount = privateKeyToAccount(key);
  const client = opts.client ?? (createPublicClient({ transport: http(config.rpcUrl, { batch: true }) }) as PublicClient);
  const contract = config.contract;
  const mints = new Map<string, PendingMint>();
  const tx = (data: Hex) => ({ to: contract, data, chainId: config.chainId });

  const byKey = db.query<{ token_id: string; owner: string; synced_level: number }, [string]>(
    "SELECT token_id, owner, synced_level FROM eth_nfts WHERE mon_key = ?");
  const byToken = db.query<{ details: string; owner: string }, [string]>("SELECT details, owner FROM eth_nfts WHERE token_id = ?");
  const listOwned = db.query<{ mon_key: string; token_id: string; synced_level: number }, [string]>(
    "SELECT mon_key, token_id, synced_level FROM eth_nfts WHERE owner = ?");
  const insert = db.query("INSERT INTO eth_nfts (mon_key, token_id, owner, species, details, synced_level, mon_hex, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const update = db.query("UPDATE eth_nfts SET details = ?, synced_level = ?, mon_hex = ?, updated_at = ? WHERE mon_key = ?");
  const setOwner = db.query("UPDATE eth_nfts SET owner = ?, updated_at = ? WHERE token_id = ?");
  const setHex = db.query("UPDATE eth_nfts SET mon_hex = ?, updated_at = ? WHERE mon_key = ?");
  const allTokens = db.query<{ token_id: string; owner: string }, []>("SELECT token_id, owner FROM eth_nfts");
  const addCopy = db.query("INSERT OR IGNORE INTO eth_game_copies (mon_key, wallet) VALUES (?, ?)");
  const dropCopy = db.query("DELETE FROM eth_game_copies WHERE mon_key = ? AND wallet = ?");
  // Owned NFTs whose monster isn't in this wallet's game yet (bought, received).
  const deliveriesFor = db.query<{ mon_key: string; token_id: string; mon_hex: string; details: string }, [string, string]>(`
    SELECT a.mon_key, a.token_id, a.mon_hex, a.details FROM eth_nfts a
    WHERE a.owner = ? AND a.mon_hex IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM eth_game_copies c WHERE c.mon_key = a.mon_key AND c.wallet = ?)`);
  // Monsters in this wallet's game whose NFT now belongs to someone else (sold).
  const revocationsFor = db.query<{ mon_key: string; token_id: string; details: string }, [string, string]>(`
    SELECT a.mon_key, a.token_id, a.details FROM eth_game_copies c JOIN eth_nfts a ON a.mon_key = c.mon_key
    WHERE c.wallet = ? AND a.owner != ?`);

  function decodeForWallet(hex: unknown): MonDetails {
    let d: MonDetails;
    try { d = decodeMon(hexToBytes(String(hex))); } catch (e) { throw new NftError(`Can't read that monster: ${(e as Error).message}.`); }
    if (!statsAreConsistent(d)) throw new NftError("That monster's stats don't match its level and IVs.");
    return d;
  }

  /** On-chain owner, or null if the token doesn't exist. */
  async function chainOwner(tokenId: bigint): Promise<string | null> {
    try { return getAddress(await client.readContract({ address: contract, abi: ABI, functionName: "ownerOf", args: [tokenId] })); }
    catch (e: any) {
      if (/ERC721NonexistentToken|reverted|0x7e273289/i.test(String(e?.message ?? e))) return null;
      throw e;
    }
  }

  async function receipt(hash: unknown) {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new NftError("Bad transaction hash.");
    let r;
    try { r = await client.waitForTransactionReceipt({ hash: hash as Hex, timeout: RECEIPT_TIMEOUT_MS }); }
    catch { throw new NftError("Still waiting on Ethereum for that transaction; it'll show up once it confirms.", 504); }
    if (r.status !== "success") throw new NftError("The transaction reverted on-chain; nothing changed.", 409);
    return r;
  }

  function record(wallet: string, d: MonDetails, hex: string) {
    const now = Date.now();
    insert.run(d.key, tokenIdOf(d.key).toString(), wallet, d.species, JSON.stringify(d), d.level, hex, now, now);
    addCopy.run(d.key, wallet); // it was minted from this wallet's game
  }

  return {
    config: () => ({ chainId: config.chainId, contract }),

    ownerOf: (monKey: string) => byKey.get(monKey)?.owner ?? null,

    list(wallet: string) {
      return listOwned.all(wallet).map((r) => ({ key: r.mon_key, tokenId: r.token_id, level: r.synced_level }));
    },

    /** A voucher + the ready-to-send mint call, or {done} if it's already on-chain in this wallet. */
    async prepareMint(wallet: string, monHex: unknown) {
      const d = decodeForWallet(monHex);
      const hex = String(monHex).toLowerCase();
      const existing = byKey.get(d.key);
      if (existing) throw new NftError(existing.owner === wallet ? "Already minted." : "That monster belongs to another wallet.", 409);
      const tokenId = tokenIdOf(d.key);
      // A mint whose receipt we never saw (tab closed mid-wait) is still on-chain: adopt it.
      const onChain = await chainOwner(tokenId);
      if (onChain) {
        if (onChain !== wallet) throw new NftError("That monster's NFT is in another wallet.", 409);
        record(wallet, d, hex);
        return { done: true, kind: "mint", tokenId: tokenId.toString(), level: d.level };
      }
      const deadline = nowS() + BigInt(VOUCHER_TTL_S);
      const signature = await signer.signTypedData({
        domain: domainOf(config), types: MINT_TYPES, primaryType: "Mint",
        message: { to: wallet as Hex, tokenId, deadline },
      });
      const opId = crypto.randomUUID();
      for (const [id, op] of mints) if (op.expires < Date.now()) mints.delete(id);
      mints.set(opId, { wallet, monKey: d.key, tokenId, details: d, hex, expires: Number(deadline) * 1000 + RECEIPT_TIMEOUT_MS });
      return {
        opId, kind: "mint", tokenId: tokenId.toString(),
        tx: tx(encodeFunctionData({ abi: ABI, functionName: "mint", args: [tokenId, deadline, signature] })),
      };
    },

    /** Level-ups only change off-chain traits: update them, no wallet needed. */
    async sync(wallet: string, monHex: unknown) {
      const d = decodeForWallet(monHex);
      const row = byKey.get(d.key);
      if (!row) throw new NftError("Not minted yet.", 404);
      if (row.owner !== wallet) throw new NftError("That monster's NFT is in another wallet.", 403);
      update.run(JSON.stringify(d), d.level, String(monHex).toLowerCase(), Date.now(), d.key);
      return { ok: true, kind: "sync", tokenId: row.token_id, level: d.level };
    },

    /** The player's wallet sent the mint: confirm it on-chain, then record it. */
    async submit(wallet: string, body: any) {
      const op = mints.get(String(body?.opId));
      if (!op || op.wallet !== wallet) throw new NftError("That request expired; try again.", 410);
      const r = await receipt(body?.hash);
      const minted = parseEventLogs({ abi: ABI, eventName: "Transfer", logs: r.logs }).some((l) =>
        getAddress(l.address) === contract && l.args.from === zeroAddress && getAddress(l.args.to) === wallet && l.args.tokenId === op.tokenId);
      if (!minted) throw new NftError("That transaction didn't mint this monster.", 409);
      mints.delete(String(body.opId));
      if (!byKey.get(op.monKey)) record(wallet, op.details, op.hex);
      return { ok: true, kind: "mint", tokenId: op.tokenId.toString(), level: op.details.level, hash: r.transactionHash };
    },

    // What this wallet's game should change: monsters to receive and to give up.
    inventory(wallet: string) {
      const name = (details: string) => { const d = JSON.parse(details) as MonDetails; return d.nickname || d.speciesName; };
      return {
        assets: listOwned.all(wallet).map((r) => ({ key: r.mon_key, tokenId: r.token_id, level: r.synced_level })),
        deliveries: deliveriesFor.all(wallet, wallet).map((r) => ({ key: r.mon_key, tokenId: r.token_id, mon: r.mon_hex, name: name(r.details) })),
        revocations: revocationsFor.all(wallet, wallet).map((r) => {
          const d = JSON.parse(r.details) as MonDetails;
          return { key: r.mon_key, tokenId: r.token_id, personality: d.personality, otId: d.otId, name: d.nickname || d.speciesName };
        }),
      };
    },

    // The browser reports its game applied a delivery or a removal.
    markCopy(wallet: string, body: any) {
      const k = String(body?.key ?? "");
      const row = byKey.get(k);
      if (!row) throw new NftError("Unknown monster.", 404);
      if (body.action === "delivered") {
        if (row.owner !== wallet) throw new NftError("That NFT isn't yours.", 403);
        addCopy.run(k, wallet);
      } else if (body.action === "removed") {
        if (row.owner === wallet) throw new NftError("You still own that NFT.", 409);
        dropCopy.run(k, wallet);
      } else throw new NftError("Unknown action.");
      return { ok: true };
    },

    // Reads every token's current owner from the chain (sales, transfers).
    async refreshOwners() {
      const rows = allTokens.all();
      let changed = 0;
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const owners = await Promise.all(batch.map((r) => chainOwner(BigInt(r.token_id)).catch(() => undefined)));
        owners.forEach((owner, j) => {
          if (!owner) return; // burned or RPC hiccup: leave the record as it was
          if (owner !== batch[j].owner) { setOwner.run(owner, Date.now(), batch[j].token_id); changed++; }
        });
      }
      return changed;
    },

    // ---- in-game trade: b signs (free), a sends and pays gas ----------------
    async prepareSwap(a: SwapSide, b: SwapSide): Promise<PreparedSwap> {
      const ra = byKey.get(a.key), rb = byKey.get(b.key);
      if (!ra || !rb) throw new NftError("Both monsters have to be NFTs before they can be traded.");
      const tokenA = BigInt(ra.token_id), tokenB = BigInt(rb.token_id);
      const [oa, ob, nonce] = await Promise.all([
        chainOwner(tokenA), chainOwner(tokenB),
        client.readContract({ address: contract, abi: ABI, functionName: "swapNonce", args: [b.wallet as Hex] }),
      ]);
      if (oa !== a.wallet || ob !== b.wallet) throw new NftError("One of those NFTs isn't owned by its trader anymore.");
      const deadline = nowS() + BigInt(SWAP_TTL_S);
      // From b's side: give their token, get a's.
      return { a, b, tokenA, tokenB, nonce, deadline, typedData: swapTypedData(config, tokenB, tokenA, nonce, deadline) };
    },

    /** Checks b's signature before a spends gas on it; returns a's ready-to-send call. */
    async acceptSwapSignature(swap: PreparedSwap, signature: unknown) {
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{2,4096}$/.test(signature)) throw new NftError("Bad swap signature.");
      const ok = await client.verifyTypedData({
        address: swap.b.wallet as Hex, domain: domainOf(config), types: SWAP_TYPES, primaryType: "Swap",
        message: { give: swap.tokenB, get: swap.tokenA, nonce: swap.nonce, deadline: swap.deadline },
        signature: signature as Hex,
      }).catch(() => false);
      if (!ok) throw new NftError("Your partner's wallet signed something else; nothing was sent.");
      swap.signature = signature as Hex;
      return tx(encodeFunctionData({ abi: ABI, functionName: "swap", args: [swap.tokenA, swap.tokenB, swap.deadline, swap.signature] }));
    },

    /** a sent the swap: confirm both tokens moved, then record it. */
    async finishSwap(swap: PreparedSwap, hash: unknown) {
      const r = await receipt(hash);
      const swapped = parseEventLogs({ abi: ABI, eventName: "Swapped", logs: r.logs }).some((l) =>
        getAddress(l.address) === contract && l.args.tokenA === swap.tokenA && l.args.tokenB === swap.tokenB);
      if (!swapped) throw new NftError("That transaction wasn't this trade's swap.", 409);
      const now = Date.now();
      setOwner.run(swap.b.wallet, now, swap.tokenA.toString());
      setOwner.run(swap.a.wallet, now, swap.tokenB.toString());
      // Each game swaps its monster in the same step (trade_exec).
      dropCopy.run(swap.a.key, swap.a.wallet); addCopy.run(swap.a.key, swap.b.wallet);
      dropCopy.run(swap.b.key, swap.b.wallet); addCopy.run(swap.b.key, swap.a.wallet);
      setHex.run(swap.a.hex, now, swap.a.key);
      setHex.run(swap.b.hex, now, swap.b.key);
      return r.transactionHash;
    },

    // ERC-721 metadata JSON that tokenURI points at: traits + art.
    metadata(tokenId: string) {
      const row = byToken.get(tokenId);
      if (!row) return null;
      const d = JSON.parse(row.details) as MonDetails;
      return {
        name: assetName(d),
        description: `${d.shiny ? "A shiny " : ""}${d.speciesName}${d.shiny ? "" : ", a Stock Monster"}. Its traits follow the monster in-game: they update every time it levels up.`,
        image: artUrl(config.publicUrl, d),
        external_url: config.publicUrl,
        attributes: traitsFor(d, hometownOf(row.owner)).map((a) => ({ trait_type: a.key, value: a.value })),
      };
    },
  };
}

export type Nft = ReturnType<typeof createNft>;
