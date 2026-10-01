import "server-only";
import { db } from "./db";

interface Row {
  count: number;
  reset_at: number;
}

/** Fixed-window counter. Returns whether this attempt is allowed. */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const conn = db();
  return conn.transaction(() => {
    if (Math.random() < 0.01) conn.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now);
    const row = conn.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").get(key) as Row | undefined;
    if (!row || row.reset_at <= now) {
      conn
        .prepare("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at")
        .run(key, now + windowMs);
      return { ok: true, retryAfterSeconds: 0 };
    }
    if (row.count >= limit) return { ok: false, retryAfterSeconds: Math.ceil((row.reset_at - now) / 1000) };
    conn.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(key);
    return { ok: true, retryAfterSeconds: 0 };
  })();
}

export function resetRateLimit(key: string) {
  db().prepare("DELETE FROM rate_limits WHERE key = ?").run(key);
}

/** Checks a limit without counting an attempt. */
export function isRateLimited(key: string, limit: number, now = Date.now()) {
  const row = db().prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").get(key) as Row | undefined;
  if (!row || row.reset_at <= now || row.count < limit) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: Math.ceil((row.reset_at - now) / 1000) };
}
