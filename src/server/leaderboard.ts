import "server-only";
import { STREAK_CERTAINLY_OVER_MS } from "@/lib/streak/engine";
import { buildBoard, compareEntries, type Board, type BoardEntry, type LiveBoard } from "@/lib/streak/leaderboard";
import { leaderboardQuery } from "@/lib/streak/leaderboard-query";
import { isStreakLive } from "@/lib/streak/live";
import { all } from "./db";
import { cfEnv } from "./env";
import { storedPlace } from "./location";

/** Rows read per query, and the most queries per refresh. */
const PAGE_SIZE = 200;
const MAX_PAGES = 3;
/**
 * Keep reading until this many live streaks are found, so the top of the board is
 * exact even when people with long streaks have just let theirs lapse.
 */
const WANT_LIVE = 100;
/**
 * How long a Worker instance reuses what it read. Streaks move a day at a time and the
 * viewer's own row is always current, so a few minutes' delay is invisible; the read
 * costs rows on D1's free plan, which grows with everyone who ever checked in.
 */
const DEFAULT_CACHE_MS = 5 * 60_000;

/** One row of leaderboardQuery (src/lib/streak/leaderboard-query.ts lists the columns). */
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
 * Live streaks, longest first. Reads the users(streak_count) index from the top, a page at a
 * time, until it has found enough live streaks. Suspended accounts and anyone whose last check-in
 * is too old to be alive are skipped; the rest are checked against the streak rules.
 */
async function readLiveBoard(now: number): Promise<LiveBoard> {
  const entries: BoardEntry[] = [];
  let after: { count: number; id: number } | null = null;
  let complete = false;
  let floor = 0;

  for (let page = 0; page < MAX_PAGES && !complete; page++) {
    const cutoff = now - STREAK_CERTAINLY_OVER_MS;
    const rows: Row[] = after
      ? await all<Row>(leaderboardQuery(true), cutoff, after.count, after.id, PAGE_SIZE)
      : await all<Row>(leaderboardQuery(false), cutoff, PAGE_SIZE);
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
  // Variables set as text are strings; one added as JSON in the dashboard could be a number.
  const raw: unknown = cfEnv().LEADERBOARD_CACHE_SECONDS;
  const seconds = typeof raw === "number" ? raw : Number(String(raw ?? "").trim() || NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_CACHE_MS;
}

/**
 * The shared read, reused for a few minutes by each Worker instance so a busy home page
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
