/** Ranking for the streak leaderboard. Pure, so it's unit-tested. */

import { streakCalendar, type Place } from "./calendar";
import { STREAK_WINDOW_HOURS, getStreakStatus, type StreakState } from "./engine";

/**
 * Whether a stored streak is still alive at `now`: the same answer as
 * `getStreakStatus(...).alive`, but anyone who checked in within the window is
 * alive without consulting the calendar (Shabbat and Yom Tov only ever move a
 * deadline later), which is nearly everyone on the board.
 */
export function isStreakLive(state: StreakState, place: Place, now: number): boolean {
  if (state.count > 0 && state.lastActivityAt !== null && now - state.lastActivityAt <= STREAK_WINDOW_HOURS * 3_600_000) {
    return true;
  }
  return getStreakStatus(state, now, streakCalendar(place)).alive;
}

/** One person's live streak. */
export interface BoardEntry {
  id: number;
  username: string;
  /** Days. Always at least 1: people whose streak is over aren't on the board. */
  count: number;
}

/** Everyone with a live streak, as last read from the database. */
export interface LiveBoard {
  /** Longest streak first (see compareEntries). */
  entries: BoardEntry[];
  /**
   * False when the database read stopped early. Anyone who wasn't read has a
   * streak of `floor` days or less, so the board is still exact above that.
   */
  complete: boolean;
  floor: number;
}

/** What a page shows for one person. Only the username is public: no ids, names or contact details. */
export interface BoardRow {
  /** 1-based. People with the same streak share a rank (1, 2, 2, 4). */
  rank: number;
  username: string;
  days: number;
  you: boolean;
}

export interface Standing extends BoardRow {
  /** The rank is a lower bound ("500+"): the read stopped before it reached everyone ahead. */
  atLeast: boolean;
  /** Someone else has the same streak. */
  tied: boolean;
}

export interface Board {
  /** The longest streaks, best first. */
  top: BoardRow[];
  /** The viewer; null when they have no streak to rank. */
  you: Standing | null;
  /** Whether `you` is one of the rows in `top`. */
  youInTop: boolean;
  /** How many streaks are live, when that's known exactly. */
  total: number | null;
}

/** Longest streak first; ties by username (case-insensitive), then by id, so the order never flickers. */
export function compareEntries(a: BoardEntry, b: BoardEntry): number {
  if (a.count !== b.count) return b.count - a.count;
  const au = a.username.toLowerCase();
  const bu = b.username.toLowerCase();
  if (au !== bu) return au < bu ? -1 : 1;
  return a.id - b.id;
}

/**
 * The board for one viewer. The shared read can be up to a minute old, so the
 * viewer's own row always comes from their current streak instead.
 */
export function buildBoard(live: LiveBoard, viewer: BoardEntry, limit: number): Board {
  const onBoard = viewer.count > 0;
  const entries = live.entries.filter((e) => e.id !== viewer.id);
  if (onBoard) entries.push(viewer);
  entries.sort(compareEntries);

  // Standard competition ranking: a row's rank is its position, unless it ties with the row above.
  let rank = 1;
  const rows = entries.map((entry, i): BoardRow => {
    if (i > 0 && entry.count !== entries[i - 1].count) rank = i + 1;
    return { rank, username: entry.username, days: entry.count, you: entry.id === viewer.id };
  });

  const top = rows.slice(0, limit);
  const you = onBoard ? rows.find((r) => r.you)! : null;
  // Everyone ahead of the viewer has a longer streak than they do, so they were all read
  // unless the read stopped at a streak at least as long as the viewer's.
  const exact = live.complete || viewer.count >= live.floor;
  return {
    top,
    you: you && { ...you, atLeast: !exact, tied: rows.some((r) => !r.you && r.rank === you.rank) },
    youInTop: !!you && top.some((r) => r.you),
    total: live.complete ? rows.length : null,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "You're #7 of 41 with a 9-day streak." */
export function describeStanding(you: Standing | null, total: number | null): string {
  if (!you) return "Check in to start a streak and join the leaderboard.";
  const streak = `${you.days}-day streak`;
  if (you.atLeast) return `You're ranked #${you.rank}+ with a ${streak}.`;
  if (you.tied) return `You're tied for #${you.rank} with a ${streak}.`;
  if (you.rank === 1) return `You're #1 with a ${streak}! 👑`;
  return `You're #${you.rank}${total ? ` of ${plural(total, "live streak")}` : ""} with a ${streak}.`;
}
