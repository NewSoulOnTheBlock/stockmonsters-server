# Stockmonsters game server

Bun server for Stockmonsters: Solana wallet login, multiplayer presence and chat,
trades, the PvP battle link relay, and the Stockmonster NFTs (Metaplex Core).
The game page itself is hosted separately (stockmonsters.app on Vercel).

- `bun run server.ts`  local dev on :8642 (also serves ../player)
- `bun test`           unit tests
- Deploy: Render Blueprint in `render.yaml` (Docker, 1 GB disk at /data).
  Set `NFT_AUTHORITY_KEY` (the update-authority secret key, JSON byte array) and
  `SOLANA_RPC_URL` in the Render dashboard. Never commit `data/`.
- Regenerate data from the ROM source: `python -I tools/gen_species.py ../stockred`,
  `python -P tools/export_art.py ../stockred`.
