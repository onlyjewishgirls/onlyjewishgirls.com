/** The leaderboard's database read. Plain strings, so tests can run it on a real SQLite database. */

/** Only what the streak rules need: never password hashes or contact details. */
export const LEADERBOARD_COLUMNS = [
  "id",
  "username",
  "streak_count",
  "streak_longest",
  "streak_last_activity_at",
  "streak_last_counted_date",
  "streak_started_at",
  "time_zone",
  "country",
  "latitude",
  "longitude",
] as const;

/**
 * Members who might have a live streak, highest stored count first. Parameters: the oldest
 * last check-in that can still be alive, then (for every page after the first) the previous
 * page's last `streak_count` and `id`, then the page size.
 *
 * Walks the users(streak_count) index from the top. A row-value cursor lets SQLite seek straight
 * past earlier pages instead of walking them again. The recency and suspension tests are checked
 * on each row as it is visited, so this saves calendar work but not reads: rows with a stale high
 * count are still read (and skipped) until enough live streaks are found.
 */
export function leaderboardQuery(afterCursor: boolean): string {
  return `SELECT ${LEADERBOARD_COLUMNS.join(", ")}
          FROM users
          WHERE streak_count > 0 AND streak_last_activity_at >= ? AND suspended_at IS NULL${
            afterCursor ? "\n            AND (streak_count, id) < (?, ?)" : ""
          }
          ORDER BY streak_count DESC, id DESC
          LIMIT ?`;
}
