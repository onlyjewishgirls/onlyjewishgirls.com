import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

/** Append-only. Each entry runs once, in order; PRAGMA user_version tracks progress. */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id                         INTEGER PRIMARY KEY,
    first_name                 TEXT NOT NULL,
    middle_name                TEXT,             -- NULL when the user has no middle name
    last_name                  TEXT NOT NULL,
    email                      TEXT NOT NULL UNIQUE,
    username                   TEXT NOT NULL,
    username_lower             TEXT NOT NULL UNIQUE,
    phone_e164                 TEXT NOT NULL,
    password_hash              TEXT NOT NULL,
    time_zone                  TEXT NOT NULL DEFAULT 'UTC',
    webauthn_user_id           TEXT NOT NULL,
    totp_secret_enc            TEXT,
    totp_pending_secret_enc    TEXT,
    totp_last_step             INTEGER,
    totp_enabled_at            INTEGER,
    recovery_codes_created_at  INTEGER,
    streak_count               INTEGER NOT NULL DEFAULT 0,
    streak_longest             INTEGER NOT NULL DEFAULT 0,
    streak_last_activity_at    INTEGER,
    streak_last_counted_date   TEXT,
    streak_started_at          INTEGER,
    streak_last_event          TEXT,             -- JSON: today's streak change, for the banner
    created_at                 INTEGER NOT NULL
  );

  CREATE TABLE passkeys (
    id           TEXT PRIMARY KEY,               -- base64url credential ID
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key   BLOB NOT NULL,
    counter      INTEGER NOT NULL,
    transports   TEXT,                           -- JSON array
    device_type  TEXT NOT NULL,
    backed_up    INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);

  CREATE TABLE recovery_codes (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    INTEGER
  );
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

  CREATE TABLE sessions (
    id_hash             TEXT PRIMARY KEY,        -- SHA-256 of the cookie value
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage               TEXT NOT NULL CHECK (stage IN ('password', 'full')),
    challenge           TEXT,
    challenge_expires_at INTEGER,
    failed_mfa_attempts INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE rate_limits (
    key      TEXT PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  );
  `,
];

function migrate(db: Database.Database) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

const globalForDb = globalThis as unknown as { __ojgDb?: Database.Database };

export function db(): Database.Database {
  if (!globalForDb.__ojgDb) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    const conn = new Database(config.databasePath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    migrate(conn);
    globalForDb.__ojgDb = conn;
  }
  return globalForDb.__ojgDb;
}
