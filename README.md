# Stockmonsters game server

Bun server for Stockmonsters: Ethereum wallet login, multiplayer presence and chat,
trades, the PvP battle link relay, and the Stockmonster NFTs (ERC-721 on Ethereum
mainnet, contract in ../contracts).
The game page itself is hosted separately (stockmonsters.app on Vercel).

- `bun run server.ts`  local dev on :8642 (also serves ../player)
- `bun test`           unit tests
- `bun run tools/eth-e2e.ts`  full mint/sync/trade/sale test against a local
  Ethereum node (run `npm install` in ../contracts first)
- NFTs: `bun run tools/nft-setup.ts signer` makes the voucher key; deploy
  ../contracts with that address; then `bun run tools/nft-setup.ts config <contract>`.
- Deploy: Render Blueprint in `render.yaml` (Docker, 1 GB disk at /data).
  Set `NFT_CONTRACT`, `NFT_SIGNER_KEY` (the voucher key from data/signer.json)
  and `ETH_RPC_URL` in the dashboard. Never commit `data/`.
- Regenerate data from the ROM source: `python -I tools/gen_species.py ../stockred`,
  `python -P tools/export_art.py ../stockred`.
