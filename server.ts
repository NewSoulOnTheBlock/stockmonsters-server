// Stockmonsters Online: presence + chat relay, and static host for the player.
// One WebSocket per player. Each map (group.num) is a pub/sub topic, so a
// player only receives movement from people on the map they are standing on.
//
// Trust model: clients report their own position. That is fine for presence;
// anything with value (trades, battles, catches) is decided here, not by them.

import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { decodeMon, hexToBytes, validateMon, type MonSummary } from "./pokemon";
import { AuthError, bearer, createAuth, shortWallet } from "./auth";
import { openDb } from "./db";
import { createNft, loadNftConfig, NftError, type PreparedSwap } from "./nft";

const PORT = Number(process.env.PORT ?? 8642);

// The game page is served from Vercel in production; let it call this API.
// ALLOWED_ORIGINS: comma-separated exact origins (e.g. https://stock-ljiulguis-projects.vercel.app).
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean));
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const corsOrigin = (req: Request) => {
  const origin = req.headers.get("origin");
  return origin && (ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin)) ? origin : null;
};
function withCors(req: Request, res: Response): Response {
  const origin = corsOrigin(req);
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  return res;
}
function preflight(req: Request): Response {
  const origin = corsOrigin(req);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } });
}
const STATIC_DIR = normalize(process.env.STATIC_DIR ?? join(import.meta.dir, "..", "player"));
const MAX_NAME = 10;
const MAX_CHAT = 120;
const CHAT_COOLDOWN_MS = 800;
const POS_MIN_INTERVAL_MS = 30;

const db = openDb();
const auth = createAuth(db);

// ---- NFTs ------------------------------------------------------------------
// Off until tools/nft-setup.ts has created the collection (data/nft.json).
const HOMETOWN_NAMES: Record<number, string> = {
  88: "GENESIS TOWN", 89: "GREENBACK CITY", 90: "BLUECHIP CITY", 91: "DIVIDEND FALLS", 92: "DELISTED TOWN",
  93: "LIQUIDITY PORT", 94: "MEGACAP CITY", 95: "FOMO CITY", 96: "BURN ISLAND", 98: "EXCHANGE CITY",
};
const hometownQuery = db.query<{ hometown: number | null }, [string]>("SELECT hometown FROM profiles WHERE wallet = ?");
const hometownOf = (wallet: string) => HOMETOWN_NAMES[hometownQuery.get(wallet)?.hometown ?? -1] ?? null;
const nftConfig = loadNftConfig();
const nft = nftConfig ? createNft(db, nftConfig, hometownOf) : null;
console.log(nft ? `NFTs on ${nftConfig!.cluster}, collection ${nftConfig!.collection}` : "NFTs off: run tools/nft-setup.ts");
const ART_DIR = join(import.meta.dir, "art");

// NFT owners change outside the game (marketplace sales), so poll the chain.
const OWNER_POLL_MS = 60_000;
let lastOwnerRefresh = 0, ownerRefresh: Promise<void> | null = null;
function refreshOwnersSoon(maxAgeMs = 15_000): Promise<void> {
  if (!nft || Date.now() - lastOwnerRefresh < maxAgeMs) return Promise.resolve();
  ownerRefresh ??= nft.refreshOwners()
    .then((n) => { if (n) console.log(`[nft] ${n} NFT owner change(s) picked up`); })
    .catch((e) => console.warn("[nft] owner refresh failed:", e?.message ?? e))
    .finally(() => { lastOwnerRefresh = Date.now(); ownerRefresh = null; });
  return ownerRefresh;
}
if (nft) setInterval(() => refreshOwnersSoon(OWNER_POLL_MS - 1000), OWNER_POLL_MS);

async function nftApi(req: Request, url: URL): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /nft/config") return Response.json(nft ? { enabled: true, ...nft.config() } : { enabled: false });
    if (route === "GET /nft/collection.json")
      return Response.json({ name: "Stock Monsters", symbol: "STKMON", description: "Every Stock Monster, living on-chain. Traits update as they level up.", image: `/nft/art/7.png` });
    const art = /^GET \/nft\/art\/(\d+s?)\.png$/.exec(route);
    if (art) {
      const file = Bun.file(join(ART_DIR, `${art[1]}.png`)); // "7" or "7s" (shiny); the regex keeps it safe
      return (await file.exists()) ? new Response(file, { headers: { "Cache-Control": "public, max-age=86400" } }) : new Response("not found", { status: 404 });
    }
    if (!nft) return Response.json({ error: "NFTs aren't set up on this server." }, { status: 503 });
    const meta = /^GET \/nft\/meta\/(\w+)\.json$/.exec(route);
    if (meta) {
      const m = nft.metadata(meta[1]);
      return m ? Response.json(m, { headers: { "Cache-Control": "no-cache" } }) : Response.json({ error: "not found" }, { status: 404 });
    }
    const wallet = auth.sessionWallet(bearer(req));
    if (!wallet) return Response.json({ error: "Not logged in." }, { status: 401 });
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : null;
    switch (route) {
      case "GET /nft/mine":
        await refreshOwnersSoon(); // a sale should show up the next time the player looks
        return Response.json(nft.inventory(wallet), { headers: { "Cache-Control": "no-store" } });
      case "POST /nft/copy": return Response.json(nft.markCopy(wallet, body));
      case "POST /nft/prepare-mint": return Response.json(await nft.prepareMint(wallet, body.mon));
      case "POST /nft/prepare-sync": return Response.json(await nft.prepareSync(wallet, body.mon));
      case "POST /nft/submit": return Response.json(await nft.submit(wallet, body));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    if (e instanceof NftError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[nft]", e);
    return Response.json({ error: "The Solana request failed; try again." }, { status: 502 });
  }
}

type Player = {
  id: string;
  name: string;
  gender: number;
  wallet: string | null; // set by a hello carrying a valid session token
  map: string | null; // "group.num"
  g: number; n: number; x: number; y: number; f: number; e: number; gfx: number;
  lastChat: number;
  lastPos: number;
};

const players = new Map<string, Player>();
const sockets = new Map<string, ServerWebSocket<Player>>();
let nextId = 1;

// ---- trading ---------------------------------------------------------------
// Flow: request -> respond(accept) -> both offer (validated here) -> both
// confirm -> [NFTs on: both wallets sign one transaction swapping the two
// NFTs; the server sends it] -> server sends each side the other's mon ->
// both report the result. The NFT is the monster, so the games only swap
// once the NFTs have.
// Any offer change clears both confirmations, so nobody can swap the mon
// after the partner agreed to it.
type Offer = { slot: number; hex: string; summary: MonSummary };
type Trade = {
  a: string; b: string;
  offers: Map<string, Offer>;
  confirmed: Set<string>;
  executing: boolean;
  results: Map<string, boolean>;
  swap?: PreparedSwap;               // the NFT swap both wallets are signing
  signed: Map<string, string>;       // player id -> their signed copy (base64)
  swapSent: boolean;
};
const REQUEST_TTL_MS = 30_000;
const tradeRequests = new Map<string, number>(); // "from>to" -> expiry
const tradeOf = new Map<string, Trade>();

const sendTo = (id: string, msg: unknown) => sockets.get(id)?.send(JSON.stringify(msg));
const partnerOf = (t: Trade, id: string) => (t.a === id ? t.b : t.a);

function closeTrade(t: Trade, reason: string) {
  for (const id of [t.a, t.b]) {
    tradeOf.delete(id);
    sendTo(id, { t: "trade_closed", reason });
  }
}

function tradeUpdate(t: Trade) {
  for (const id of [t.a, t.b]) {
    const mine = t.offers.get(id), theirs = t.offers.get(partnerOf(t, id));
    sendTo(id, {
      t: "trade_update",
      mine: mine ? { slot: mine.slot, ...mine.summary } : null,
      theirs: theirs ? theirs.summary : null,
      iConfirmed: t.confirmed.has(id),
      theyConfirmed: t.confirmed.has(partnerOf(t, id)),
    });
  }
}

// ---- PvP battles -------------------------------------------------------------
// Request -> accept -> each game starts FireRed's own link battle with a link
// id (the challenger is 0, the master that runs the battle). From then on the
// server only relays: link blocks (the battle engine's data) and standby
// barriers, in order, between the two sockets.
type Battle = { a: string; b: string; outcomes: Map<string, number> };
const battleRequests = new Map<string, number>(); // "from>to" -> expiry
const battleOf = new Map<string, Battle>();
const MAX_BLOCK_B64 = 400; // a link block is at most 256 bytes
const OUTCOME_TEXT: Record<number, string> = { 1: "won", 2: "lost", 3: "drew" };

function endBattle(bt: Battle) {
  battleOf.delete(bt.a); battleOf.delete(bt.b);
}

function onBattle(ws: ServerWebSocket<Player>, m: any) {
  const me = ws.data;
  const fail = (reason: string) => send(ws, { t: "battle_error", reason });
  switch (m.t) {
    case "battle_request": {
      const target = players.get(String(m.to));
      if (!target || target.id === me.id) return fail("That player is gone.");
      if (target.map !== me.map) return fail("You need to be on the same map.");
      if (battleOf.has(me.id) || battleOf.has(target.id) || tradeOf.has(me.id) || tradeOf.has(target.id))
        return fail("One of you is busy.");
      battleRequests.set(`${me.id}>${target.id}`, Date.now() + REQUEST_TTL_MS);
      sendTo(target.id, { t: "battle_request", from: me.id, name: me.name });
      return send(ws, { t: "battle_pending", name: target.name });
    }
    case "battle_respond": {
      const from = String(m.from), key = `${from}>${me.id}`;
      const expiry = battleRequests.get(key);
      battleRequests.delete(key);
      if (!expiry || expiry < Date.now() || !players.has(from)) return fail("That challenge expired.");
      if (!m.accept) return sendTo(from, { t: "battle_error", reason: `${me.name} declined the battle.` });
      if (battleOf.has(me.id) || battleOf.has(from)) return fail("One of you is busy.");
      const bt: Battle = { a: from, b: me.id, outcomes: new Map() };
      battleOf.set(from, bt); battleOf.set(me.id, bt);
      sendTo(from, { t: "battle_start", linkId: 0, partner: { id: me.id, name: me.name } });
      return send(ws, { t: "battle_start", linkId: 1, partner: { id: from, name: players.get(from)!.name } });
    }
  }
  const bt = battleOf.get(me.id);
  if (!bt) return;
  const partner = bt.a === me.id ? bt.b : bt.a;
  switch (m.t) {
    case "link_block":
      if (typeof m.data !== "string" || m.data.length > MAX_BLOCK_B64) return;
      return sendTo(partner, { t: "link_block", data: m.data });
    case "link_standby":
      return sendTo(partner, { t: "link_standby", n: int(m.n, 0, 255) });
    case "battle_end": {
      bt.outcomes.set(me.id, int(m.outcome, 0, 255));
      if (bt.outcomes.size < 2 && players.has(partner)) return;
      endBattle(bt);
      const winner = [...bt.outcomes.entries()].find(([, o]) => o === 1)?.[0];
      const names = (id: string) => players.get(id)?.name ?? "someone";
      const text = winner ? `${names(winner)} defeated ${names(winner === bt.a ? bt.b : bt.a)}!` : `${names(bt.a)} and ${names(bt.b)} battled to a draw.`;
      for (const id of [bt.a, bt.b]) sendTo(id, { t: "battle_over", text, outcome: OUTCOME_TEXT[bt.outcomes.get(id) ?? 0] ?? "ended" });
      return;
    }
  }
}

// Both games swap monsters (after the NFTs swapped, when NFTs are on).
function execTrade(t: Trade) {
  for (const id of [t.a, t.b]) {
    const give = t.offers.get(id)!, receive = t.offers.get(partnerOf(t, id))!;
    sendTo(id, { t: "trade_exec", giveSlot: give.slot, givePersonality: give.summary.personality, receive: receive.hex });
  }
}

function onTrade(ws: ServerWebSocket<Player>, m: any) {
  const me = ws.data;
  const fail = (reason: string) => send(ws, { t: "trade_error", reason });

  switch (m.t) {
    case "trade_request": {
      const target = players.get(String(m.to));
      if (!target || target.id === me.id) return fail("That player is gone.");
      if (target.map !== me.map) return fail("You need to be on the same map.");
      if (tradeOf.has(me.id) || tradeOf.has(target.id)) return fail("One of you is already trading.");
      tradeRequests.set(`${me.id}>${target.id}`, Date.now() + REQUEST_TTL_MS);
      sendTo(target.id, { t: "trade_request", from: me.id, name: me.name });
      return send(ws, { t: "trade_pending", to: target.id, name: target.name });
    }
    case "trade_respond": {
      const from = String(m.from), key = `${from}>${me.id}`;
      const expiry = tradeRequests.get(key);
      tradeRequests.delete(key);
      if (!expiry || expiry < Date.now() || !players.has(from)) return fail("That request expired.");
      if (!m.accept) return sendTo(from, { t: "trade_closed", reason: `${me.name} declined.` });
      if (tradeOf.has(me.id) || tradeOf.has(from)) return fail("One of you is already trading.");
      const t: Trade = { a: from, b: me.id, offers: new Map(), confirmed: new Set(), executing: false, results: new Map(), signed: new Map(), swapSent: false };
      tradeOf.set(from, t); tradeOf.set(me.id, t);
      sendTo(from, { t: "trade_open", partner: { id: me.id, name: me.name } });
      return send(ws, { t: "trade_open", partner: { id: from, name: players.get(from)!.name } });
    }
  }

  const t = tradeOf.get(me.id);
  if (!t) return fail("You aren't in a trade.");
  switch (m.t) {
    case "trade_offer": {
      if (t.executing) return;
      let summary: MonSummary;
      try { summary = validateMon(hexToBytes(m.mon)); } catch (e) { return fail(`Can't offer that: ${(e as Error).message}.`); }
      if (nft) {
        const owner = nft.ownerOf(decodeMon(hexToBytes(m.mon)).key);
        if (!owner) return fail(`${summary.nickname || summary.speciesName} isn't an NFT yet. Mint it first, then trade.`);
        if (owner !== me.wallet) return fail(`${summary.nickname || summary.speciesName}'s NFT isn't in your wallet.`);
      }
      t.offers.set(me.id, { slot: int(m.slot, 0, 5), hex: String(m.mon).toLowerCase(), summary });
      t.confirmed.clear();
      return tradeUpdate(t);
    }
    case "trade_confirm": {
      if (t.executing || t.offers.size < 2) return;
      t.confirmed.add(me.id);
      tradeUpdate(t);
      if (t.confirmed.size < 2) return;
      t.executing = true;
      if (!nft) return execTrade(t);
      const side = (id: string) => {
        const o = t.offers.get(id)!;
        return { wallet: players.get(id)!.wallet!, key: decodeMon(hexToBytes(o.hex)).key, hex: o.hex };
      };
      nft.prepareSwap(side(t.a), side(t.b)).then((swap) => {
        if (tradeOf.get(t.a) !== t) return; // cancelled meanwhile
        t.swap = swap;
        const tx = Buffer.from(swap.tx).toString("base64");
        for (const id of [t.a, t.b]) sendTo(id, { t: "trade_sign", tx, cluster: nft.config().cluster });
      }).catch((e) => closeTrade(t, e instanceof NftError ? e.message : "Couldn't set up the NFT swap; try again."));
      return;
    }
    case "trade_signed": {
      if (!t.swap || t.swapSent || t.signed.has(me.id)) return;
      t.signed.set(me.id, String(m.tx));
      if (t.signed.size < 2) return;
      t.swapSent = true;
      const swap = t.swap;
      nft!.finishSwap(swap, t.signed.get(t.a)!, t.signed.get(t.b)!)
        .then(() => execTrade(t))
        .catch((e) => closeTrade(t, e instanceof NftError ? e.message : "The NFT swap didn't go through; nothing moved."));
      return;
    }
    case "trade_result": {
      if (!t.executing) return;
      t.results.set(me.id, !!m.ok);
      if (t.results.size < 2) return;
      const ok = [...t.results.values()].every(Boolean);
      // Each game applies its half locally; if only one side applied, say so
      // plainly rather than pretend it rolled back.
      return closeTrade(t, ok ? "complete" : "One side's party changed mid-trade; check both parties.");
    }
    case "trade_cancel":
      // Until the swap is sent, either wallet can still back out.
      if (t.executing && (!t.swap || t.swapSent)) return;
      return closeTrade(t, `${me.name} cancelled.`);
  }
}

const int = (v: unknown, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.trunc(Number(v)) || 0));
const cleanText = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

const mapTopic = (map: string) => `map:${map}`;
const publicView = (p: Player) => ({
  id: p.id, name: p.name, wallet: p.wallet ? shortWallet(p.wallet) : null, g: p.g, n: p.n, x: p.x, y: p.y, f: p.f, e: p.e, gfx: p.gfx,
});

function send(ws: ServerWebSocket<Player>, msg: unknown) {
  ws.send(JSON.stringify(msg));
}

function leaveMap(ws: ServerWebSocket<Player>) {
  const p = ws.data;
  if (!p.map) return;
  ws.unsubscribe(mapTopic(p.map));
  // server.publish, not ws.publish: this also runs from close(), when the socket can no longer send.
  server.publish(mapTopic(p.map), JSON.stringify({ t: "leave", id: p.id }));
  p.map = null;
}

function enterMap(ws: ServerWebSocket<Player>, map: string) {
  const p = ws.data;
  p.map = map;
  ws.subscribe(mapTopic(map));
  const others = [...players.values()].filter((o) => o.map === map && o.id !== p.id).map(publicView);
  send(ws, { t: "snapshot", players: others });
}

function onPos(ws: ServerWebSocket<Player>, m: any) {
  const p = ws.data;
  const now = Date.now();
  if (now - p.lastPos < POS_MIN_INTERVAL_MS) return;
  p.lastPos = now;

  p.g = int(m.g, 0, 255); p.n = int(m.n, 0, 255);
  p.x = int(m.x, -32768, 32767); p.y = int(m.y, -32768, 32767);
  p.f = int(m.f, 0, 4); p.e = int(m.e, 0, 15); p.gfx = int(m.gfx, 0, 255);

  const map = `${p.g}.${p.n}`;
  if (map !== p.map) {
    leaveMap(ws);
    enterMap(ws, map);
  }
  ws.publish(mapTopic(map), JSON.stringify({ t: "pos", ...publicView(p) }));
}

function onChat(ws: ServerWebSocket<Player>, m: any) {
  const p = ws.data;
  const now = Date.now();
  const text = cleanText(m.text, MAX_CHAT);
  if (!text || now - p.lastChat < CHAT_COOLDOWN_MS) return;
  p.lastChat = now;
  const scope = m.scope === "map" && p.map ? "map" : "global";
  const msg = JSON.stringify({ t: "chat", scope, id: p.id, name: p.name, text });
  const topic = scope === "map" ? mapTopic(p.map!) : "global";
  server.publish(topic, msg); // server.publish includes the sender
}

// ---- login + profile API ---------------------------------------------------
async function api(req: Request, url: URL): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  const json = async () => { try { return await req.json(); } catch { throw new AuthError("Body must be JSON."); } };
  const needSession = () => {
    const wallet = auth.sessionWallet(bearer(req));
    if (!wallet) throw new AuthError("Not logged in.", 401);
    return wallet;
  };
  try {
    switch (route) {
      case "GET /auth/nonce":
        return Response.json(auth.issueNonce(url.searchParams.get("wallet")), { headers: { "Cache-Control": "no-store" } });
      case "POST /auth/verify":
        return Response.json(auth.verifyLogin(await json()));
      case "GET /auth/session": {
        const s = auth.session(bearer(req));
        return s ? Response.json(s, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Not logged in." }, { status: 401 });
      }
      case "POST /auth/logout":
        auth.logout(bearer(req));
        return Response.json({ ok: true });
      case "POST /profile": {
        const wallet = needSession();
        return Response.json({ profile: auth.updateProfile(wallet, await json()) });
      }
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[auth]", e);
    return Response.json({ error: "server error" }, { status: 500 });
  }
}

const server = Bun.serve<Player>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const p: Player = {
        id: String(nextId++), name: "TRAINER", gender: 0, wallet: null, map: null,
        g: 0, n: 0, x: 0, y: 0, f: 1, e: 0, gfx: 0, lastChat: 0, lastPos: 0,
      };
      return srv.upgrade(req, { data: p }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, players: players.size });
    const isApi = url.pathname.startsWith("/auth/") || url.pathname === "/profile" || url.pathname.startsWith("/nft/");
    if (isApi && req.method === "OPTIONS") return preflight(req);
    if (url.pathname.startsWith("/auth/") || url.pathname === "/profile") return withCors(req, await api(req, url));
    if (url.pathname.startsWith("/nft/")) return withCors(req, await nftApi(req, url));

    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const path = normalize(join(STATIC_DIR, rel));
    if (!path.startsWith(STATIC_DIR)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    // The ROM and netplay.js are a matched pair (mailbox layout); never let a
    // browser pair a cached copy of one with a fresh copy of the other.
    return new Response(file, { headers: { "Cache-Control": "no-cache", "Last-Modified": new Date(file.lastModified).toUTCString() } });
  },
  websocket: {
    open(ws) {
      players.set(ws.data.id, ws.data);
      sockets.set(ws.data.id, ws);
      ws.subscribe("global");
      send(ws, { t: "welcome", id: ws.data.id, online: players.size });
    },
    message(ws, raw) {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      switch (m?.t) {
        case "hello": {
          const wallet = auth.sessionWallet(m.token);
          if (!wallet) { send(ws, { t: "auth", ok: false }); break; }
          if (!ws.data.wallet) send(ws, { t: "auth", ok: true, wallet: shortWallet(wallet) });
          ws.data.wallet = wallet;
          ws.data.name = cleanText(m.name, MAX_NAME) || "TRAINER";
          ws.data.gender = int(m.gender, 0, 1);
          break;
        }
        // Everything below needs a signed-in wallet; anonymous sockets only listen.
        case "pos": if (ws.data.wallet) onPos(ws, m); break;
        case "chat": if (ws.data.wallet) onChat(ws, m); break;
        default:
          if (ws.data.wallet && typeof m?.t === "string" && m.t.startsWith("trade_")) onTrade(ws, m);
          else if (ws.data.wallet && typeof m?.t === "string" && (m.t.startsWith("battle_") || m.t.startsWith("link_"))) onBattle(ws, m);
      }
    },
    close(ws) {
      const t = tradeOf.get(ws.data.id);
      if (t) closeTrade(t, `${ws.data.name} disconnected.`);
      const bt = battleOf.get(ws.data.id);
      if (bt) {
        // The partner's game ends the battle as a win (NetPlay_OnPartnerLost).
        const partner = bt.a === ws.data.id ? bt.b : bt.a;
        sendTo(partner, { t: "link_lost", name: ws.data.name });
        bt.outcomes.set(ws.data.id, 2);
      }
      leaveMap(ws);
      players.delete(ws.data.id);
      sockets.delete(ws.data.id);
    },
  },
});

console.log(`Stockmonsters Online on http://localhost:${server.port} (static: ${STATIC_DIR})`);
