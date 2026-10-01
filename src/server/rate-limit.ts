import "server-only";
import { first, run } from "./db";

/**
 * Fixed-window counter, done in one statement so concurrent requests can't
 * both slip under the limit. Returns whether this attempt is allowed.
 */
export async function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const row = await first<{ count: number; reset_at: number }>(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count    = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
     RETURNING count, reset_at`,
    key,
    now + windowMs,
    now,
  );
  if (!row || row.count <= limit) return { ok: true, retryAfterSeconds: 0 };
  return { ok: false, retryAfterSeconds: Math.ceil((row.reset_at - now) / 1000) };
}

export async function resetRateLimit(key: string) {
  await run("DELETE FROM rate_limits WHERE key = ?", key);
}

/** Checks a limit without counting an attempt. */
export async function isRateLimited(key: string, limit: number, now = Date.now()) {
  const row = await first<{ count: number; reset_at: number }>(
    "SELECT count, reset_at FROM rate_limits WHERE key = ?",
    key,
  );
  if (!row || row.reset_at <= now || row.count < limit) return { limited: false, retryAfterSeconds: 0 };
  return { limited: true, retryAfterSeconds: Math.ceil((row.reset_at - now) / 1000) };
}
