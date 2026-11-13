/**
 * Database migrations, applied automatically the first time each Worker
 * instance touches the database (applyMigrations, below). Append new entries;
 * never edit old ones. Each entry is a list of statements run atomically.
 * No imports: the Worker entry (src/worker/) uses this file outside Next.js.
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
  [
    // Admin panel: roles, suspension, notes, device info and an activity log.
    `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner'))`,
    "ALTER TABLE users ADD COLUMN suspended_at INTEGER",
    "ALTER TABLE users ADD COLUMN suspended_reason TEXT",
    "ALTER TABLE users ADD COLUMN admin_note TEXT",
    "ALTER TABLE users ADD COLUMN last_login_at INTEGER",
    // Set when an admin gives someone a temporary password; cleared when they choose their own.
    "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN ip TEXT",
    "ALTER TABLE sessions ADD COLUMN user_agent TEXT",
    "ALTER TABLE sessions ADD COLUMN country TEXT",
    "ALTER TABLE sessions ADD COLUMN city TEXT",
    "ALTER TABLE sessions ADD COLUMN verified_at INTEGER", // last time a second factor was checked
    `CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY,
      at             INTEGER NOT NULL,
      type           TEXT NOT NULL,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username       TEXT,                         -- kept so history survives account deletion
      actor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_username TEXT,
      ip             TEXT,
      user_agent     TEXT,
      country        TEXT,
      detail         TEXT,                         -- JSON
      undo           TEXT,                         -- JSON: how to reverse an admin change, if it can be
      reverted_at    INTEGER,
      reverted_by    TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS events_at ON events(at)`,
    `CREATE INDEX IF NOT EXISTS events_user_at ON events(user_id, at)`,
    `CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at)`,
    // The site owner.
    `UPDATE users SET role = 'owner' WHERE email = 'briefchaimyuir@gmail.com'`,
  ],
  [
    // Full name in lowercase for admin search. SQLite's LOWER only folds A-Z, so the app
    // writes it (see searchName in users.ts); this backfill is exact for existing ASCII names.
    "ALTER TABLE users ADD COLUMN search_name TEXT",
    "UPDATE users SET search_name = LOWER(first_name || ' ' || COALESCE(middle_name || ' ', '') || last_name)",
  ],
  [
    // Visitor log: one row per page view, signed in or not (kept 90 days).
    `CREATE TABLE IF NOT EXISTS visits (
      id          INTEGER PRIMARY KEY,
      at          INTEGER NOT NULL,
      visitor_id  TEXT NOT NULL,                   -- random id in a first-party cookie, to follow one browser
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username    TEXT,                            -- kept if the account is deleted
      path        TEXT NOT NULL,                   -- no query string, so reset links never land here
      referrer    TEXT,                            -- another site's address, without its query string
      ip          TEXT,
      country     TEXT,
      city        TEXT,
      asn         INTEGER,
      network     TEXT,                            -- the visitor's ISP or hosting company
      user_agent  TEXT,
      language    TEXT,
      time_zone   TEXT,
      screen      TEXT,                            -- viewport width x height
      bot         INTEGER NOT NULL DEFAULT 0
    )`,
    // One index only: D1 bills each index as another row written, and this table gets a row per page view.
    `CREATE INDEX IF NOT EXISTS visits_at ON visits(at)`,
  ],
  [
    // Portal standard (PORTAL-STANDARD.md): settings, streak restores, IP allow/deny lists,
    // suspicious-activity strikes and the security-alert log.
    `CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,                    -- JSON
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    )`,
    // Extra console permissions on top of the role, e.g. ["streaks.manage"] (JSON array).
    "ALTER TABLE users ADD COLUMN permissions TEXT",
    // An administrator's lock (separate from the automatic wrong-password lockout). NULL = not locked;
    // a far-future time = locked until unlocked.
    "ALTER TABLE users ADD COLUMN locked_until INTEGER",
    "ALTER TABLE users ADD COLUMN locked_reason TEXT",
    `CREATE TABLE IF NOT EXISTS streak_restores (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('self', 'admin', 'grant')),
      from_count  INTEGER NOT NULL,
      to_count    INTEGER NOT NULL,
      month       TEXT NOT NULL,                   -- "YYYY-MM" in the portal time zone
      created_at  INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS streak_restores_user_month ON streak_restores(user_id, month)`,
    `CREATE TABLE IF NOT EXISTS streak_restore_grants (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month    TEXT NOT NULL,
      extra    INTEGER NOT NULL,
      PRIMARY KEY (user_id, month)
    )`,
    `CREATE TABLE IF NOT EXISTS ip_rules (
      id              INTEGER PRIMARY KEY,
      kind            TEXT NOT NULL CHECK (kind IN ('allow', 'deny')),
      ip              TEXT NOT NULL,               -- an address or a CIDR range
      label           TEXT,
      source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
      reason          TEXT,
      trigger_kind    TEXT,                        -- auto blocks: what tripped it
      evidence        TEXT,                        -- JSON array of strings
      was_allowlisted INTEGER NOT NULL DEFAULT 0,
      owner_session   INTEGER NOT NULL DEFAULT 0,
      sessions_killed INTEGER NOT NULL DEFAULT 0,
      hits            INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expires_at      INTEGER,                     -- NULL = permanent
      revoked_at      INTEGER,
      revoked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_reason  TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS ip_rules_kind ON ip_rules(kind, revoked_at)`,
    `CREATE TABLE IF NOT EXISTS ip_strikes (
      id       INTEGER PRIMARY KEY,
      ip       TEXT NOT NULL,
      kind     TEXT NOT NULL,                      -- failed_password, failed_mfa, admin_denied, rate_limit, decoy, injection
      subject  TEXT,                               -- account id (or hashed name) or path
      at       INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ip_strikes_ip_at ON ip_strikes(ip, at)`,
    `CREATE TABLE IF NOT EXISTS security_alerts (
      id            INTEGER PRIMARY KEY,
      at            INTEGER NOT NULL,
      event         TEXT NOT NULL,
      dedupe_key    TEXT NOT NULL,
      subject       TEXT NOT NULL,
      to_addr       TEXT NOT NULL,
      from_addr     TEXT NOT NULL,
      status        TEXT NOT NULL,                 -- queued, sent, throttled, failed
      provider      TEXT,
      error         TEXT,
      suppressed    INTEGER NOT NULL DEFAULT 0,    -- earlier throttled alerts folded into this one
      ip            TEXT,
      user_id       INTEGER,
      username      TEXT,
      audit_id      INTEGER,
      owner_lockout INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS security_alerts_key_at ON security_alerts(event, dedupe_key, at)`,
    `CREATE INDEX IF NOT EXISTS security_alerts_at ON security_alerts(at)`,
    // Single-use challenges for "Sign in with a passkey" (no session exists yet).
    `CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge  TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`,
  ],
  [
    // Email codes (PORTAL-STANDARD §3: passkey, authenticator app, email). On per person by default;
    // only offered when email is configured (see email-otp.ts).
    "ALTER TABLE users ADD COLUMN email_otp_enabled INTEGER NOT NULL DEFAULT 1",
    `CREATE TABLE IF NOT EXISTS email_codes (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash   TEXT NOT NULL,                   -- SHA-256 of the code with the account id
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS email_codes_user ON email_codes(user_id, created_at)`,
  ],
  [
    // The CAPTCHA wall (PORTAL-STANDARD §10, gate-kit/): challenges served, solved, failed and blocked,
    // counted per UTC hour and written in batches by the Worker entry (src/worker/captcha.ts). Counters
    // only: traffic without a pass is never audited, alerted or blacklisted.
    `CREATE TABLE IF NOT EXISTS gate_stats (
      hour  TEXT NOT NULL,                         -- UTC, '2026-11-12T22'
      event TEXT NOT NULL,                         -- challenge_served, blocked, verify_ok, verify_failed, passed, misconfigured, gate_off
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, event)
    )`,
  ],
];

async function currentVersion(d1: D1Database): Promise<number> {
  const row = await d1.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").first<{ v: number }>();
  return row?.v ?? 0;
}

/**
 * Applies every migration this database hasn't had yet. Used by the app (db.ts, through the OpenNext
 * request context) and by the Worker entry before the CAPTCHA wall writes its counters, so neither
 * depends on the other having touched the database first. Safe to run concurrently.
 */
export async function applyMigrations(d1: D1Database) {
  await d1
    .prepare("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
    .run();
  for (let version = await currentVersion(d1); version < MIGRATIONS.length; version++) {
    try {
      await d1.batch([
        ...MIGRATIONS[version].map((sql) => d1.prepare(sql)),
        d1.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").bind(version + 1, Date.now()),
      ]);
    } catch (error) {
      // Another Worker instance may have applied this migration at the same moment.
      if ((await currentVersion(d1)) <= version) throw error;
    }
  }
}
