// NFT setup for Ethereum, in two steps around the contract deploy.
//
//   1. bun run tools/nft-setup.ts signer
//        Creates the game's voucher key (data/signer.json) and prints its
//        address. It signs mint vouchers only: it holds no ETH and can't move
//        tokens. Deploy contracts/ with this address as NFT_SIGNER.
//
//   2. bun run tools/nft-setup.ts config <contract> [--chain 1] [--rpc URL] [--public https://www.stockmonsters.app]
//        Checks the contract's signer() is our key, then writes data/nft-eth.json.
//        Restart the server and NFTs are on.
//
// Production uses env vars instead (see nft.ts): NFT_SIGNER_KEY, NFT_CONTRACT,
// ETH_RPC_URL, NFT_CHAIN_ID, PUBLIC_URL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, getAddress, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ABI, DATA_DIR, DEFAULT_RPC, NFT_CONFIG_PATH, SIGNER_PATH, signerKey } from "../nft";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
mkdirSync(DATA_DIR, { recursive: true });

if (cmd === "signer") {
  if (existsSync(SIGNER_PATH)) {
    const { address } = JSON.parse(readFileSync(SIGNER_PATH, "utf8"));
    console.log(`Voucher key already exists: ${address}`);
  } else {
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    writeFileSync(SIGNER_PATH, JSON.stringify({ address, privateKey }, null, 2) + "\n", { mode: 0o600 });
    console.log(`Created voucher key ${address} in data/signer.json (never commit data/).`);
  }
  console.log("Deploy the contract with this as NFT_SIGNER, then run: bun run tools/nft-setup.ts config <contract>");
} else if (cmd === "config") {
  const contract = getAddress(rest[0] ?? "");
  const chainId = Number(flag("chain", "1"));
  const rpcUrl = flag("rpc", process.env.ETH_RPC_URL ?? DEFAULT_RPC);
  const publicUrl = flag("public", "https://www.stockmonsters.app").replace(/\/+$/, "");
  const key = signerKey();
  if (!key) throw new Error("No voucher key yet: run `bun run tools/nft-setup.ts signer` first.");
  const client = createPublicClient({ transport: http(rpcUrl) });
  const actualChain = await client.getChainId();
  if (actualChain !== chainId) throw new Error(`RPC is chain ${actualChain}, expected ${chainId}.`);
  const onChainSigner = getAddress(await client.readContract({ address: contract, abi: ABI, functionName: "signer" }));
  const ours = privateKeyToAccount(key).address;
  if (onChainSigner !== ours) throw new Error(`Contract signer is ${onChainSigner}, but our key is ${ours}. Call setSigner(${ours}) from the owner wallet.`);
  writeFileSync(NFT_CONFIG_PATH, JSON.stringify({ chainId, rpcUrl, contract, publicUrl }, null, 2) + "\n");
  console.log(`NFTs configured: chain ${chainId}, contract ${contract}, metadata at ${publicUrl}/nft/meta/. Restart the server.`);
} else {
  console.log("usage: bun run tools/nft-setup.ts signer | config <contract> [--chain 1] [--rpc URL] [--public URL]");
  process.exit(1);
}
