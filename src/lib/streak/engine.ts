/**
 * 🔥 Streak rules
 *
 * 1. Check in (sign in, or open the site while signed in) at least once every
 *    30 hours. 30 hours is enough to cover a regular Shabbat if you check in on
 *    Friday afternoon and again after Havdalah.
 * 2. When a 2- or 3-day Yom Tov falls inside your window (counting a Shabbat
 *    that runs into it), the window grows by 24 hours for every day beyond the
 *    first: +24h for a 2-day Yom Tov, +48h for a 3-day one.
 * 3. Your streak goes up by one for each new calendar day you check in on.
 *    Shabbat and Yom Tov days you passed over also count, so keeping Shabbat
 *    never costs you a day.
 * 4. Miss the deadline and the next check-in starts a new streak at 1.
 */

import type { HolyDayLookup } from "./calendar";
import { addDays, daysBetween, localDate } from "./dates";

export const STREAK_WINDOW_HOURS = 30;
export const YOM_TOV_EXTRA_DAY_HOURS = 24;
export const AT_RISK_HOURS = 4;

const HOUR_MS = 3_600_000;
/** No run of Shabbat + Yom Tov is longer than 3 days; this just bounds the loops. */
const MAX_BLOCK_DAYS = 7;

export interface StreakState {
  count: number;
  longest: number;
  lastActivityAt: number | null;
  /** Local date ("YYYY-MM-DD") of the last check-in that counted toward the streak. */
  lastCountedDate: string | null;
  startedAt: number | null;
}

export const EMPTY_STREAK: StreakState = {
  count: 0,
  longest: 0,
  lastActivityAt: null,
  lastCountedDate: null,
  startedAt: null,
};

export interface Leeway {
  /** The Shabbat / Yom Tov dates in this block, in order. */
  dates: string[];
  names: string[];
  extraHours: number;
}

export interface Deadline {
  deadline: number;
  leeway: Leeway[];
}

/** When the streak expires if there is no check-in after `lastActivityAt`. */
export function computeDeadline(lastActivityAt: number, timeZone: string, holyDays: HolyDayLookup): Deadline {
  let deadline = lastActivityAt + STREAK_WINDOW_HOURS * HOUR_MS;
  const leeway: Leeway[] = [];
  const lastDate = localDate(lastActivityAt, timeZone);
  const seen = new Set<string>();

  // Extending the deadline can bring another block into range, so repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    const lastDay = localDate(deadline, timeZone);
    for (let date = addDays(lastDate, 1); date <= lastDay; date = addDays(date, 1)) {
      if (holyDays(date).length === 0) continue;

      // Only the days still ahead of the user count, so a block already in progress shrinks.
      const block = [date];
      while (block.length < MAX_BLOCK_DAYS && holyDays(addDays(block[block.length - 1], 1)).length > 0) {
        block.push(addDays(block[block.length - 1], 1));
      }
      date = block[block.length - 1];
      if (seen.has(block[0])) continue;
      seen.add(block[0]);

      if (block.length >= 2) {
        const extraHours = (block.length - 1) * YOM_TOV_EXTRA_DAY_HOURS;
        deadline += extraHours * HOUR_MS;
        const names = [...new Set(block.flatMap(holyDays))];
        leeway.push({ dates: block, names, extraHours });
        changed = true;
      }
    }
  }
  return { deadline, leeway };
}

export type ActivityOutcome = "started" | "continued" | "same-day" | "restarted";

export interface ActivityResult {
  state: StreakState;
  outcome: ActivityOutcome;
  /** How many days this check-in added. */
  added: number;
  /** The streak before this check-in (useful for "your 12-day streak ended"). */
  previousCount: number;
}

export function recordActivity(
  state: StreakState,
  now: number,
  timeZone: string,
  holyDays: HolyDayLookup,
): ActivityResult {
  const today = localDate(now, timeZone);
  const previousCount = state.count;
  const start = (outcome: ActivityOutcome): ActivityResult => ({
    state: {
      count: 1,
      longest: Math.max(state.longest, 1),
      lastActivityAt: now,
      lastCountedDate: today,
      startedAt: now,
    },
    outcome,
    added: 1,
    previousCount,
  });

  if (state.lastActivityAt === null || state.lastCountedDate === null || state.count === 0) {
    return start("started");
  }

  const { deadline } = computeDeadline(state.lastActivityAt, timeZone, holyDays);
  if (now > deadline) return start("restarted");

  // Same day, or the user's clock moved backwards across a time-zone change.
  if (today <= state.lastCountedDate) {
    return {
      state: { ...state, lastActivityAt: Math.max(now, state.lastActivityAt) },
      outcome: "same-day",
      added: 0,
      previousCount,
    };
  }

  let added = 1;
  const gap = Math.min(daysBetween(state.lastCountedDate, today), MAX_BLOCK_DAYS + 2);
  for (let i = 1; i < gap; i++) {
    if (holyDays(addDays(state.lastCountedDate, i)).length > 0) added++;
  }
  const count = state.count + added;
  return {
    state: {
      count,
      longest: Math.max(state.longest, count),
      lastActivityAt: now,
      lastCountedDate: today,
      startedAt: state.startedAt ?? now,
    },
    outcome: "continued",
    added,
    previousCount,
  };
}

export interface StreakStatus {
  /** Current streak; 0 once the deadline has passed. */
  count: number;
  longest: number;
  alive: boolean;
  deadline: number | null;
  remainingMs: number | null;
  /** Less than AT_RISK_HOURS left — show the ⌛. */
  atRisk: boolean;
  checkedInToday: boolean;
  leeway: Leeway[];
}

export function getStreakStatus(
  state: StreakState,
  now: number,
  timeZone: string,
  holyDays: HolyDayLookup,
): StreakStatus {
  if (state.lastActivityAt === null || state.count === 0) {
    return {
      count: 0,
      longest: state.longest,
      alive: false,
      deadline: null,
      remainingMs: null,
      atRisk: false,
      checkedInToday: false,
      leeway: [],
    };
  }
  const { deadline, leeway } = computeDeadline(state.lastActivityAt, timeZone, holyDays);
  const remainingMs = deadline - now;
  const alive = remainingMs >= 0;
  return {
    count: alive ? state.count : 0,
    longest: state.longest,
    alive,
    deadline,
    remainingMs: alive ? remainingMs : 0,
    atRisk: alive && remainingMs < AT_RISK_HOURS * HOUR_MS,
    checkedInToday: state.lastCountedDate === localDate(now, timeZone),
    leeway,
  };
}
