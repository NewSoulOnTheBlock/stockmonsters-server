// Gen 3 party Pokemon (struct Pokemon, 100 bytes) decoding and validation.
// Layout per stockred/include/pokemon.h; the 48-byte secure block is four
// 12-byte substructs, XOR-encrypted with (personality ^ otId) and shuffled by
// personality % 24.

import speciesTable from "./species.json";
import moveTable from "./moves.json";

export const MON_SIZE = 100;
const NUM_SPECIES: number = speciesTable.numSpecies;
const SPECIES_NAMES: Record<string, string> = speciesTable.names;
type SpeciesInfo = { slot: string; ticker: string | null; base: number[]; types: string[] };
const SPECIES_INFO = speciesTable.info as Record<string, SpeciesInfo>;
const MOVE_NAMES: Record<string, string> = moveTable.names;

// Position of [Growth, Attacks, EVs, Misc] in the secure block for each order.
const ORDERS = [
  "GAEM", "GAME", "GEAM", "GEMA", "GMAE", "GMEA", "AGEM", "AGME", "AEGM", "AEMG", "AMGE", "AMEG",
  "EGAM", "EGMA", "EAGM", "EAMG", "EMGA", "EMAG", "MGAE", "MGEA", "MAGE", "MAEG", "MEGA", "MEAG",
];

export const NATURES = [
  "HARDY", "LONELY", "BRAVE", "ADAMANT", "NAUGHTY", "BOLD", "DOCILE", "RELAXED", "IMPISH", "LAX",
  "TIMID", "HASTY", "SERIOUS", "JOLLY", "NAIVE", "MODEST", "MILD", "QUIET", "BASHFUL", "RASH",
  "CALM", "GENTLE", "SASSY", "CAREFUL", "QUIRKY",
];

// Stat order everywhere below is the in-game one: HP, ATK, DEF, SPEED, SP.ATK, SP.DEF.
export type Stats = [number, number, number, number, number, number];

export type MonSummary = {
  personality: number;
  species: number;
  speciesName: string;
  nickname: string;
  level: number;
  heldItem: number;
};

export type MonDetails = MonSummary & {
  otId: number;
  otName: string;
  ticker: string | null;
  types: string[];
  nature: string;
  experience: number;
  moves: string[];
  ivs: Stats;
  evs: Stats;
  stats: Stats;   // as stored in the party struct (max HP first)
  shiny: boolean;
  key: string;    // stable identity of this individual: personality + OT id
};

// Game charset subset used by names (charmap.txt).
export function decodeText(bytes: Uint8Array): string {
  let s = "";
  for (const c of bytes) {
    if (c === 0xff) break;
    if (c >= 0xbb && c <= 0xd4) s += String.fromCharCode(65 + c - 0xbb);
    else if (c >= 0xd5 && c <= 0xee) s += String.fromCharCode(97 + c - 0xd5);
    else if (c >= 0xa1 && c <= 0xaa) s += String.fromCharCode(48 + c - 0xa1);
    else if (c === 0x00) s += " ";
    else if (c === 0xad) s += ".";
    else if (c === 0xae) s += "-";
  }
  return s.trim();
}

// The game's own rule (pokemon.c IsMonShiny): 8 in 65536.
export const isShiny = (personality: number, otId: number) =>
  ((otId >>> 16) ^ (otId & 0xffff) ^ (personality >>> 16) ^ (personality & 0xffff)) < 8;

export const monKey = (personality: number, otId: number) =>
  `${(personality >>> 0).toString(16).padStart(8, "0")}${(otId >>> 0).toString(16).padStart(8, "0")}`;

// Full decode; throws with the reason the mon can't be traded or minted.
export function decodeMon(bytes: Uint8Array): MonDetails {
  if (bytes.length !== MON_SIZE) throw new Error("wrong size");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const personality = dv.getUint32(0, true);
  const otId = dv.getUint32(4, true);
  const flags = bytes[19];
  if (flags & 0b001) throw new Error("bad egg");
  if (!(flags & 0b010)) throw new Error("empty slot");
  if (flags & 0b100) throw new Error("eggs can't be traded");

  const key = (personality ^ otId) >>> 0;
  const secure = new DataView(new ArrayBuffer(48));
  let sum = 0;
  for (let i = 0; i < 48; i += 4) {
    const word = (dv.getUint32(32 + i, true) ^ key) >>> 0;
    secure.setUint32(i, word, true);
    sum = (sum + (word & 0xffff) + (word >>> 16)) & 0xffff;
  }
  if (sum !== dv.getUint16(28, true)) throw new Error("checksum mismatch");

  const order = ORDERS[personality % 24];
  const G = order.indexOf("G") * 12, A = order.indexOf("A") * 12, E = order.indexOf("E") * 12, M = order.indexOf("M") * 12;
  const species = secure.getUint16(G, true);
  const ivWord = secure.getUint32(M + 4, true);
  if (ivWord & (1 << 30)) throw new Error("eggs can't be traded");
  if (species === 0 || species >= NUM_SPECIES) throw new Error("invalid species");

  const level = bytes[84];
  if (level < 1 || level > 100) throw new Error("invalid level");

  const moves: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = secure.getUint16(A + i * 2, true);
    if (id) moves.push(MOVE_NAMES[String(id)] ?? `MOVE ${id}`);
  }
  // IVs and EVs are packed HP, ATK, DEF, SPEED, SP.ATK, SP.DEF: same order as Stats.
  const ivs = [0, 1, 2, 3, 4, 5].map((i) => (ivWord >>> (5 * i)) & 31) as Stats;
  const evs = [0, 1, 2, 3, 4, 5].map((i) => secure.getUint8(E + i)) as Stats;
  const stats = [88, 90, 92, 94, 96, 98].map((o) => dv.getUint16(o, true)) as Stats;
  const info = SPECIES_INFO[String(species)];

  return {
    personality, otId, species, level, ivs, evs, stats, moves,
    heldItem: secure.getUint16(G + 2, true),
    experience: secure.getUint32(G + 4, true),
    speciesName: SPECIES_NAMES[String(species)] ?? `#${species}`,
    nickname: decodeText(bytes.subarray(8, 18)),
    otName: decodeText(bytes.subarray(20, 27)),
    ticker: info?.ticker ?? null,
    types: info?.types ?? [],
    nature: NATURES[personality % 25],
    shiny: isShiny(personality, otId),
    key: monKey(personality, otId),
  };
}

// Kept for trading: the summary the trade window shows.
export function validateMon(bytes: Uint8Array): MonSummary {
  const d = decodeMon(bytes);
  return { personality: d.personality, species: d.species, speciesName: d.speciesName, nickname: d.nickname, level: d.level, heldItem: d.heldItem };
}

// Gen 3 stat formula. Catches stats edited directly in RAM; it cannot catch
// edited IVs/EVs/experience, which change the inputs consistently.
export function expectedStats(d: MonDetails): Stats | null {
  const base = SPECIES_INFO[String(d.species)]?.base;
  if (!base) return null;
  const nature = d.personality % 25;
  const up = 1 + Math.floor(nature / 5), down = 1 + (nature % 5); // index into Stats; HP is never affected
  return base.map((b, i) => {
    const core = Math.floor(((2 * b + d.ivs[i] + Math.floor(d.evs[i] / 4)) * d.level) / 100);
    if (i === 0) return core + d.level + 10;
    const raw = core + 5;
    if (up === down) return raw;
    return i === up ? Math.floor((raw * 110) / 100) : i === down ? Math.floor((raw * 90) / 100) : raw;
  }) as Stats;
}

export function statsAreConsistent(d: MonDetails): boolean {
  const want = expectedStats(d);
  return !!want && want.every((v, i) => v === d.stats[i]);
}

export const hexToBytes = (hex: string) => {
  if (typeof hex !== "string" || !/^[0-9a-f]*$/i.test(hex) || hex.length !== MON_SIZE * 2) throw new Error("bad encoding");
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
};
