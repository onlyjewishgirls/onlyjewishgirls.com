import "server-only";
import { STREAK_CERTAINLY_OVER_MS } from "@/lib/streak/engine";
import { buildBoard, compareEntries, isStreakLive, type Board, type BoardEntry, type LiveBoard } from "@/lib/streak/leaderboard";
import { all } from "./db";
import { cfEnv } from "./env";
import { storedPlace } from "./location";

/** Rows read per query, and the most queries per refresh. */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
/**
 * Keep reading until this many live streaks are found, so the top of the board is
 * exact even when people with long streaks have just let theirs lapse.
 */
const WANT_LIVE = 100;
const DEFAULT_CACHE_MS = 60_000;

/** Only what the streak rules need: never password hashes or contact details. */
interface Row {
  id: number;
  username: string;
  streak_count: number;
  streak_longest: number;
  streak_last_activity_at: number;
  streak_last_counted_date: string | null;
  streak_started_at: number | null;
  time_zone: string;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** A stored count doesn't drop to 0 until the person comes back, so each one is checked against the streak rules. */
function isLive(row: Row, now: number): boolean {
  const state = {
    count: row.streak_count,
    longest: row.streak_longest,
    lastActivityAt: row.streak_last_activity_at,
    lastCountedDate: row.streak_last_counted_date,
    startedAt: row.streak_started_at,
  };
  return isStreakLive(state, storedPlace({ ...row, timeZone: row.time_zone }), now);
}

/**
 * Live streaks, longest first. Reads from the streak_count index in order, so it
 * touches about a page of rows rather than every user, and skips suspended
 * accounts. A page holds `PAGE_SIZE` rows; the loop stops once enough live
 * streaks are found.
 */
async function readLiveBoard(now: number): Promise<LiveBoard> {
  const entries: BoardEntry[] = [];
  let after: { count: number; id: number } | null = null;
  let complete = false;
  let floor = 0;

  for (let page = 0; page < MAX_PAGES && !complete; page++) {
    const rows: Row[] = await all<Row>(
      `SELECT id, username, streak_count, streak_longest, streak_last_activity_at, streak_last_counted_date,
              streak_started_at, time_zone, country, latitude, longitude
       FROM users
       WHERE streak_count > 0 AND streak_last_activity_at >= ? AND suspended_at IS NULL
         AND (? IS NULL OR streak_count < ? OR (streak_count = ? AND id < ?))
       ORDER BY streak_count DESC, id DESC
       LIMIT ?`,
      now - STREAK_CERTAINLY_OVER_MS,
      after && after.count,
      after && after.count,
      after && after.count,
      after && after.id,
      PAGE_SIZE,
    );
    for (const row of rows) {
      if (isLive(row, now)) entries.push({ id: row.id, username: row.username, count: row.streak_count });
    }
    if (rows.length < PAGE_SIZE) {
      complete = true;
    } else {
      const last = rows[rows.length - 1];
      after = { count: last.streak_count, id: last.id };
      floor = last.streak_count;
      if (entries.length >= WANT_LIVE) break;
    }
  }

  entries.sort(compareEntries);
  return { entries, complete, floor: complete ? 0 : floor };
}

let cached: { at: number; board: LiveBoard } | undefined;

function cacheMs(): number {
  const seconds = Number(cfEnv().LEADERBOARD_CACHE_SECONDS?.trim() || NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_CACHE_MS;
}

/**
 * The shared read, reused for a minute by each Worker instance so a busy home page
 * doesn't read the database on every view. (Only a finished result is kept; sharing
 * an in-flight promise between requests isn't allowed on Workers.)
 */
async function liveBoard(now: number): Promise<LiveBoard> {
  if (cached && now >= cached.at && now - cached.at < cacheMs()) return cached.board;
  const board = await readLiveBoard(now);
  cached = { at: now, board };
  return board;
}

/** The leaderboard as one signed-in member sees it: the longest live streaks, and where they stand. */
export async function leaderboardFor(
  viewer: { id: number; username: string; streak: number },
  limit: number,
  now = Date.now(),
): Promise<Board> {
  return buildBoard(await liveBoard(now), { id: viewer.id, username: viewer.username, count: viewer.streak }, limit);
}
