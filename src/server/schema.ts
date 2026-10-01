/**
 * Database migrations, applied automatically the first time each Worker
 * instance touches the database. Append new entries; never edit old ones.
 * Each entry is a list of statements run atomically.
 */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS users (
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
    )`,
    `CREATE TABLE IF NOT EXISTS passkeys (
      id           TEXT PRIMARY KEY,               -- base64url credential ID
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key   TEXT NOT NULL,                  -- base64url COSE public key
      counter      INTEGER NOT NULL,
      transports   TEXT,                           -- JSON array
      device_type  TEXT NOT NULL,
      backed_up    INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id)`,
    `CREATE TABLE IF NOT EXISTS recovery_codes (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      used_at    INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS recovery_codes_user ON recovery_codes(user_id)`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id_hash              TEXT PRIMARY KEY,       -- SHA-256 of the cookie value
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stage                TEXT NOT NULL CHECK (stage IN ('password', 'full')),
      challenge            TEXT,
      challenge_expires_at INTEGER,
      failed_mfa_attempts  INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      last_seen_at         INTEGER NOT NULL,
      expires_at           INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key      TEXT PRIMARY KEY,
      count    INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    )`,
  ],
  [
    // Approximate location (from Cloudflare) for Shabbat / Yom Tov times.
    "ALTER TABLE users ADD COLUMN latitude REAL",
    "ALTER TABLE users ADD COLUMN longitude REAL",
    "ALTER TABLE users ADD COLUMN country TEXT",
    `CREATE TABLE IF NOT EXISTS password_resets (
      token_hash  TEXT PRIMARY KEY,                -- SHA-256 of the emailed token
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id)`,
  ],
];
