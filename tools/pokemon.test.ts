import { expect, test } from "bun:test";
import { decodeMon, validateMon, hexToBytes } from "../pokemon";
import { craftMon, toHex } from "./craft-mon";

test("accepts a well-formed mon for every substruct order", () => {
  for (let p = 0; p < 24; p++) {
    const s = validateMon(craftMon(25, 12, "SPARKY", 0x10000 * 7 + p));
    expect(s.species).toBe(25);
    expect(s.speciesName).toBe("AURORYX");
    expect(s.nickname).toBe("SPARKY");
    expect(s.level).toBe(12);
  }
});
test("rejects tampering, eggs, empty slots and bad species", () => {
  const tampered = craftMon(1, 5, "A"); tampered[40] ^= 1;
  expect(() => validateMon(tampered)).toThrow("checksum");
  const egg = craftMon(1, 5, "A"); egg[19] |= 0b100;
  expect(() => validateMon(egg)).toThrow("egg");
  expect(() => validateMon(new Uint8Array(100))).toThrow("empty");
  expect(() => validateMon(craftMon(999, 5, "A"))).toThrow("species");
  expect(() => validateMon(craftMon(1, 0, "A"))).toThrow("level");
});
test("hex decoding is strict", () => {
  expect(() => hexToBytes("zz")).toThrow();
  expect(hexToBytes(toHex(craftMon(1, 5, "A"))).length).toBe(100);
});

test("shiny follows the game's rule: OT and personality halves XOR below 8", () => {
  const otId = 0x1234abcd;
  const shinyPersonality = (((0x1234 ^ 0xabcd) << 16) | 0x0003) >>> 0; // XOR comes out to 3
  expect(decodeMon(craftMon(25, 5, "SPARKY", shinyPersonality, otId)).shiny).toBe(true);
  expect(decodeMon(craftMon(25, 5, "SPARKY", (shinyPersonality ^ 0x8) >>> 0, otId)).shiny).toBe(false); // XOR 11
});
