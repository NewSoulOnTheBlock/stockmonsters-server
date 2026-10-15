# Stockmonsters game server: login, multiplayer, trades, PvP relay, NFTs.
FROM oven/bun:1.3.5
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["bun", "run", "server.ts"]
