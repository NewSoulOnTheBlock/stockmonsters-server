// End-to-end against a local Ethereum node: deploys StockMonsters, runs the
// real server, and drives two players through login -> mint -> level-up sync
// -> an in-game trade (partner signs, requester sends) -> an outside sale.
//
//   bun run tools/eth-e2e.ts      (needs `npm install` in ../contracts)

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { craftMon } from "./craft-mon";
import { decodeMon, expectedStats } from "../pokemon";
import { ABI } from "../nft";

const RPC = "http://127.0.0.1:8545";
const PORT = 8699;
const SERVER = `http://127.0.0.1:${PORT}`;
const CONTRACTS = join(import.meta.dir, "..", "..", "contracts");
// Hardhat's well-known account #0 deploys and funds fresh random players.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let passed = 0;
const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  passed++;
  console.log(`  ok  ${what}`);
};
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// craftMon leaves stats at 0; fill in the real ones so the anti-cheat check passes.
function mon(species: number, level: number, nick: string, personality: number, otId: number) {
  const bytes = craftMon(species, level, nick, personality, otId);
  const stats = expectedStats(decodeMon(bytes))!;
  const dv = new DataView(bytes.buffer);
  dv.setUint16(86, stats[0], true);
  stats.forEach((v, i) => dv.setUint16(88 + i * 2, v, true));
  return bytes;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const node = Bun.spawn(["npx", "hardhat", "node", "--port", "8545"], { cwd: CONTRACTS, stdout: "ignore", stderr: "ignore" });
let server: ReturnType<typeof Bun.spawn> | null = null;
const dbPath = join(tmpdir(), `sm-e2e-${Date.now()}.db`);

try {
  const pub = createPublicClient({ chain: hardhat, transport: http(RPC) });
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break; } catch { if (i > 120) throw new Error("hardhat node didn't start"); await sleep(500); }
  }
  const wallet = (k: Hex) => createWalletClient({ chain: hardhat, transport: http(RPC), account: privateKeyToAccount(k) });
  const deployer = wallet(DEPLOYER_KEY);
  const [alice, bob, carol] = [0, 1, 2].map(() => wallet(generatePrivateKey()));
  for (const p of [alice, bob, carol])
    await pub.waitForTransactionReceipt({ hash: await deployer.sendTransaction({ to: p.account.address, value: 10n ** 19n }) });

  // Deploy with a fresh voucher key, the way production will.
  const signerKey = generatePrivateKey();
  const art = JSON.parse(readFileSync(join(CONTRACTS, "artifacts/contracts/StockMonsters.sol/StockMonsters.json"), "utf8"));
  const deployHash = await deployer.deployContract({
    abi: art.abi, bytecode: art.bytecode,
    args: [deployer.account.address, privateKeyToAccount(signerKey).address, `${SERVER}/nft/meta/`, `${SERVER}/nft/collection.json`],
  });
  const contract = getAddress((await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!);
  console.log(`contract ${contract}`);

  server = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "inherit",
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, NFT_SIGNER_KEY: signerKey, NFT_CONTRACT: contract, NFT_CHAIN_ID: "31337", ETH_RPC_URL: RPC, PUBLIC_URL: SERVER },
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${SERVER}/health`)).ok) break; } catch {}
    if (i > 60) throw new Error("server didn't start");
    await sleep(250);
  }

  const api = async (path: string, token?: string | null, body?: unknown) => {
    const res = await fetch(SERVER + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out: any = await res.json().catch(() => ({}));
    return { status: res.status, ...out };
  };

  console.log("\nlogin");
  const login = async (w: typeof alice) => {
    const addr = w.account.address.toLowerCase(); // wallets often hand out lowercase
    const { nonce } = await api(`/auth/nonce?wallet=${addr}`);
    const message = `Stock Monsters login\nWallet: ${addr}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
    const signature = await w.signMessage({ message });
    return api("/auth/verify", null, { wallet: addr, message, signature });
  };
  const sa = await login(alice), sb = await login(bob);
  ok(sa.token && sa.wallet === alice.account.address, "alice logs in; address comes back checksummed");
  ok(sb.token && sb.wallet === bob.account.address, "bob logs in");
  const bad = await api("/auth/nonce?wallet=So11111111111111111111111111111111111111112");
  ok(bad.status === 400 && /Ethereum/.test(bad.error), "a Solana address is refused");
  const cfg = await api("/nft/config");
  ok(cfg.enabled && cfg.chainId === 31337 && cfg.contract === contract, "/nft/config reports the contract");

  console.log("\nmint");
  const monA = mon(25, 12, "SPARKY", 0xa1a1a1a1, 0x00001111);
  const monB = mon(4, 9, "CHAR", 0xb2b2b2b2, 0x00002222);
  const mint = async (w: typeof alice, token: string, mon: Uint8Array) => {
    const op = await api("/nft/prepare-mint", token, { mon: toHex(mon) });
    if (op.status !== 200) throw new Error(op.error);
    const hash = await w.sendTransaction({ to: op.tx.to, data: op.tx.data });
    return { op, done: await api("/nft/submit", token, { opId: op.opId, hash }) };
  };
  const ma = await mint(alice, sa.token, monA);
  const tokenA = BigInt(ma.op.tokenId);
  ok(ma.done.ok && tokenA === 0xa1a1a1a100001111n, "alice mints SPARKY; token id = personality<<32 | OT id");
  ok(getAddress(await pub.readContract({ address: contract, abi: ABI, functionName: "ownerOf", args: [tokenA] })) === alice.account.address, "on-chain owner is alice");
  const mb = await mint(bob, sb.token, monB);
  const tokenB = BigInt(mb.op.tokenId);
  ok(mb.done.ok, "bob mints CHAR");
  const again = await api("/nft/prepare-mint", sa.token, { mon: toHex(monA) });
  ok(again.status === 409, "minting the same monster twice is refused");
  const steal = await api("/nft/prepare-mint", sb.token, { mon: toHex(monA) });
  ok(steal.status === 409, "bob can't mint alice's monster");

  // A voucher replayed by someone else reverts on-chain.
  const monC = mon(7, 5, "SQUIRT", 0xc3c3c3c3, 0x00003333);
  const opC = await api("/nft/prepare-mint", sa.token, { mon: toHex(monC) });
  const replay = await bob.sendTransaction({ to: opC.tx.to, data: opC.tx.data, gas: 200_000n })
    .then((h) => pub.waitForTransactionReceipt({ hash: h })).then((r) => r.status, (e) => String(e?.details ?? e));
  ok(replay === "reverted" || /BadSignature/.test(String(replay)), "alice's voucher sent from bob's wallet reverts (BadSignature)");
  // A mint whose submit never arrived is adopted on the next prepare.
  await alice.sendTransaction({ to: opC.tx.to, data: opC.tx.data }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  const adopted = await api("/nft/prepare-mint", sa.token, { mon: toHex(monC) });
  ok(adopted.done === true, "a mint the server never heard about is adopted from the chain");

  const meta = await api(`/nft/meta/${tokenA}.json`);
  ok(meta.name === "SPARKY (AUR)" && meta.attributes.some((a: any) => a.trait_type === "Level" && a.value === "12"), "tokenURI metadata shows level 12");
  const uri = await pub.readContract({ address: contract, abi: [...ABI, { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] }] as const, functionName: "tokenURI", args: [tokenA] });
  ok(uri === `${SERVER}/nft/meta/${tokenA}.json`, "contract tokenURI points at the game server");

  console.log("\nlevel-up sync (no transaction)");
  const monA2 = mon(25, 14, "SPARKY", 0xa1a1a1a1, 0x00001111);
  const synced = await api("/nft/sync", sa.token, { mon: toHex(monA2) });
  ok(synced.ok && synced.level === 14, "sync updates the level");
  ok((await api(`/nft/meta/${tokenA}.json`)).attributes.some((a: any) => a.trait_type === "Level" && a.value === "14"), "metadata now says 14");
  ok((await api("/nft/sync", sb.token, { mon: toHex(monA2) })).status === 403, "bob can't sync alice's monster");

  console.log("\nin-game trade");
  type Sock = { ws: WebSocket; inbox: any[]; wait: (t: string, ms?: number) => Promise<any>; send: (m: any) => void; id: string };
  const connect = async (token: string, name: string): Promise<Sock> => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const inbox: any[] = [];
    const waiters: { t: string; res: (m: any) => void }[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m);
    };
    await new Promise((r) => (ws.onopen = r));
    const wait = (t: string, ms = 30_000) => {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise<any>((res, rej) => {
        waiters.push({ t, res });
        setTimeout(() => rej(new Error(`${name}: no ${t} (inbox: ${inbox.map((m) => m.t).join(",")})`)), ms);
      });
    };
    const send = (m: any) => ws.send(JSON.stringify(m));
    const { id } = await wait("welcome");
    send({ t: "hello", token, name, gender: 0 });
    ok((await wait("auth")).ok, `${name} socket authenticates`);
    send({ t: "pos", g: 3, n: 0, x: 5, y: 5, f: 1, e: 0, gfx: 0 });
    return { ws, inbox, wait, send, id };
  };
  const A = await connect(sa.token, "ALICE"), B = await connect(sb.token, "BOB");
  await sleep(200);
  A.send({ t: "trade_request", to: B.id });
  await B.wait("trade_request");
  B.send({ t: "trade_respond", from: A.id, accept: true });
  await A.wait("trade_open"); await B.wait("trade_open");
  A.send({ t: "trade_offer", slot: 0, mon: toHex(monA2) });
  B.send({ t: "trade_offer", slot: 0, mon: toHex(monB) });
  await sleep(200);
  A.send({ t: "trade_confirm" }); B.send({ t: "trade_confirm" });

  // Bob (partner) signs for free; alice (requester) waits.
  const sign = await B.wait("trade_sign");
  ok((await A.wait("trade_wait")).text.includes("approve"), "requester is told to wait for the partner's signature");
  const td = sign.typedData;
  ok(td.primaryType === "Swap" && BigInt(td.message.give) === tokenB && BigInt(td.message.get) === tokenA, "partner signs: give CHAR, get SPARKY");
  const { EIP712Domain, ...types } = td.types;
  const bobSig = await bob.signTypedData({ domain: td.domain, types, primaryType: "Swap", message: td.message });
  // A forged signature (alice signing for bob) is caught before anyone pays gas: test on a throwaway copy first.
  B.send({ t: "trade_signed", signature: bobSig });
  const send = await A.wait("trade_send");
  ok(send.tx.to === contract, "requester gets the swap call to send");
  const ethBefore = await pub.getBalance({ address: bob.account.address });
  const swapHash = await alice.sendTransaction({ to: send.tx.to, data: send.tx.data });
  A.send({ t: "trade_sent", hash: swapHash });
  const [ea, eb] = await Promise.all([A.wait("trade_exec", 60_000), B.wait("trade_exec", 60_000)]);
  ok(ea.receive === toHex(monB).toLowerCase() && eb.receive === toHex(monA2).toLowerCase(), "each game receives the other's monster");
  A.send({ t: "trade_result", ok: true }); B.send({ t: "trade_result", ok: true });
  ok((await A.wait("trade_closed")).reason === "complete", "trade completes");
  const owner = (t: bigint) => pub.readContract({ address: contract, abi: ABI, functionName: "ownerOf", args: [t] }).then(getAddress);
  ok((await owner(tokenA)) === bob.account.address && (await owner(tokenB)) === alice.account.address, "both NFTs swapped on-chain");
  ok((await pub.getBalance({ address: bob.account.address })) === ethBefore, "the partner paid no gas");

  console.log("\nforged partner signature");
  A.send({ t: "trade_request", to: B.id });
  await B.wait("trade_request");
  B.send({ t: "trade_respond", from: A.id, accept: true });
  await A.wait("trade_open"); await B.wait("trade_open");
  A.send({ t: "trade_offer", slot: 0, mon: toHex(monB) });   // alice now owns CHAR
  B.send({ t: "trade_offer", slot: 0, mon: toHex(monA2) });  // bob owns SPARKY
  await sleep(200);
  A.send({ t: "trade_confirm" }); B.send({ t: "trade_confirm" });
  const sign2 = await B.wait("trade_sign");
  const { EIP712Domain: _d, ...types2 } = sign2.typedData.types;
  const forged = await carol.signTypedData({ domain: sign2.typedData.domain, types: types2, primaryType: "Swap", message: sign2.typedData.message });
  B.send({ t: "trade_signed", signature: forged });
  ok(/signed something else/.test((await A.wait("trade_closed")).reason), "a signature from the wrong wallet closes the trade before gas is spent");

  console.log("\noutside sale moves the monster");
  await bob.writeContract({ address: contract, abi: [...ABI, { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] }] as const, functionName: "transferFrom", args: [bob.account.address, carol.account.address, tokenA] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  await sleep(16_000); // the server refreshes owners at most every 15s on /nft/mine
  const invB = await api("/nft/mine", sb.token);
  ok(invB.revocations.some((r: any) => r.key === decodeMon(monA2).key), "bob's game is told SPARKY left");
  const sc = await login(carol);
  const invC = await api("/nft/mine", sc.token);
  ok(invC.deliveries.some((d: any) => d.key === decodeMon(monA2).key && d.mon), "carol's game gets SPARKY delivered");

  A.ws.close(); B.ws.close();
  console.log(`\n${passed} checks passed`);
} finally {
  // npx spawns a child node; on Windows only a tree kill stops it.
  const killTree = (pid?: number) => { if (!pid) return; if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]); else process.kill(pid); };
  killTree(server?.pid);
  killTree(node.pid);
  try { rmSync(dbPath, { force: true }); rmSync(dbPath + "-wal", { force: true }); rmSync(dbPath + "-shm", { force: true }); } catch {}
}
