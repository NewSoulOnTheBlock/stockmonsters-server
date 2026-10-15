// Test helper: builds a valid encrypted party Pokemon (100 bytes) so trades
// can be exercised without playing to the first starter.
// Usage: bun run tools/craft-mon.ts <species> <level> <NICKNAME>  -> prints hex

const ORDERS = [
  "GAEM", "GAME", "GEAM", "GEMA", "GMAE", "GMEA", "AGEM", "AGME", "AEGM", "AEMG", "AMGE", "AMEG",
  "EGAM", "EGMA", "EAGM", "EAMG", "EMGA", "EMAG", "MGAE", "MGEA", "MAGE", "MAEG", "MEGA", "MEAG",
];

function encodeText(s: string, len: number): number[] {
  const out: number[] = [];
  for (const ch of s.toUpperCase().slice(0, len)) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out.push(0xbb + c - 65);
    else if (c >= 48 && c <= 57) out.push(0xa1 + c - 48);
    else out.push(0x00);
  }
  while (out.length < len) out.push(0xff);
  return out;
}

export function craftMon(species: number, level: number, nickname: string, personality = (Math.random() * 2 ** 32) >>> 0, otId = 0x1234abcd): Uint8Array {
  const bytes = new Uint8Array(100);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, personality, true);
  dv.setUint32(4, otId, true);
  bytes.set(encodeText(nickname, 10), 8);
  bytes[18] = 2;            // LANGUAGE_ENGLISH
  bytes[19] = 0b010;        // hasSpecies
  bytes.set(encodeText("BOT", 7), 20);

  const plain = new DataView(new ArrayBuffer(48));
  const order = ORDERS[personality % 24];
  const G = order.indexOf("G") * 12, A = order.indexOf("A") * 12, M = order.indexOf("M") * 12;
  plain.setUint16(G, species, true);
  plain.setUint32(G + 4, level ** 3, true);       // medium-fast exp curve; game recalcs level from exp
  plain.setUint8(G + 9, 70);                       // friendship
  plain.setUint16(A, 33, true);                    // MOVE_TACKLE
  plain.setUint8(A + 8, 35);                       // its PP
  plain.setUint32(M + 4, 0x0f7bdef, true);         // IVs 15 across the board, not an egg

  let sum = 0;
  const key = (personality ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) {
    const word = plain.getUint32(i, true);
    sum = (sum + (word & 0xffff) + (word >>> 16)) & 0xffff;
    dv.setUint32(32 + i, (word ^ key) >>> 0, true);
  }
  dv.setUint16(28, sum, true);
  bytes[84] = level;
  dv.setUint16(86, 20, true); // hp; CalculateMonStats fixes stats on receipt
  dv.setUint16(88, 20, true);
  return bytes;
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

if (import.meta.main) {
  const [species = "1", level = "5", nick = "TESTMON"] = process.argv.slice(2);
  console.log(toHex(craftMon(Number(species), Number(level), nick)));
}
