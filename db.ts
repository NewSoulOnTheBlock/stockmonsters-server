// SQLite storage for logins and profiles. One file, created on first run.
// Pass ":memory:" (tests) or set DB_PATH to use somewhere else.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_DB_PATH = join(import.meta.dir, "data", "stockmonsters.db");

export function openDb(path = process.env.DB_PATH ?? DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      wallet     TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nonces (
      nonce      TEXT PRIMARY KEY,
      wallet     TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      wallet     TEXT PRIMARY KEY,
      name       TEXT,
      gender     INTEGER,
      hometown   INTEGER NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces(expires_at);
  `);
  return db;
}
