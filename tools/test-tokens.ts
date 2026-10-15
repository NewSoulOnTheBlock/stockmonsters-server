// Logs the two scripted test wallets in and prints their session tokens
// (for headless browser tests). Never use with real player keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { AUTHORITY_PATH, DATA_DIR } from "../nft";
const BASE = process.env.SERVER ?? "http://127.0.0.1:8642";
const umi = createUmi("http://127.0.0.1:1");
const out: Record<string, { wallet: string; token: string }> = {};
for (const [name, path] of [["a", AUTHORITY_PATH], ["b", join(DATA_DIR, "test-player.json")]] as const) {
  const kp = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const wallet = kp.publicKey.toString();
  const { nonce } = await (await fetch(`${BASE}/auth/nonce?wallet=${wallet}`)).json() as any;
  const message = `Stock Monsters login\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
  const signature = Buffer.from(await umi.eddsa.sign(new TextEncoder().encode(message), kp)).toString("base64");
  const res = await (await fetch(`${BASE}/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet, message, signature }) })).json() as any;
  out[name] = { wallet, token: res.token };
}
console.log(JSON.stringify(out));
