/**
 * Courtesy restore and admin set-streak (PORTAL-STANDARD §4), ported from
 * WAMV's streak.js `restorePlan()` / `setPlan()` onto this site's engine
 * (sunset-based Shabbat / Yom Tov windows, see engine.ts). Pure functions.
 */

import type { StreakCalendar } from "./calendar";
import { addDays, localDate } from "./dates";
import { getStreakStatus, type StreakState } from "./engine";

const DAY_MS = 86_400_000;

/** The streak change recorded by the day's first check-in (users.streak_last_event). */
export interface LastStreakEvent {
  date: string;
  outcome: "started" | "continued" | "restarted";
  added: number;
  previousCount: number;
  /** Set once a restore has put the lost streak back, so it can't be restored twice. */
  restored?: boolean;
}

export interface RestorePlan {
  /** What the streak shows now (0 for a lapsed one). */
  from: number;
  to: number;
  state: StreakState;
}

/**
 * What a courtesy restore would put back, without writing anything. Two cases, as in WAMV:
 *  - It broke on today's check-in (this site counts today as day 1 of a new streak): the
 *    restore is the lost count plus today's. Offered only on the day it broke.
 *  - It has lapsed and nobody has checked in since (a page left open past the deadline):
 *    restoring counts today and starts the window again from now.
 * Returns null when there is nothing to restore.
 */
export function restorePlan(
  state: StreakState,
  lastEvent: LastStreakEvent | null,
  now: number,
  calendar: StreakCalendar,
): RestorePlan | null {
  const today = localDate(now, calendar.timeZone);
  const status = getStreakStatus(state, now, calendar);
  if (
    lastEvent &&
    lastEvent.outcome === "restarted" &&
    !lastEvent.restored &&
    lastEvent.previousCount > 0 &&
    lastEvent.date === today &&
    status.alive
  ) {
    const to = lastEvent.previousCount + Math.max(state.count, 1);
    return {
      from: state.count,
      to,
      state: {
        ...state,
        count: to,
        longest: Math.max(state.longest, to),
        startedAt: now - (to - 1) * DAY_MS,
      },
    };
  }
  if (state.count > 0 && state.lastActivityAt !== null && !status.alive) {
    const to = state.count + 1;
    return {
      from: 0,
      to,
      state: {
        count: to,
        longest: Math.max(state.longest, to),
        lastActivityAt: now,
        lastCountedDate: today,
        startedAt: state.startedAt ?? now - (to - 1) * DAY_MS,
      },
    };
  }
  return null;
}

export const MAX_SET_STREAK = 10_000;

/**
 * The state an admin's "Set streak to N" writes. N includes today and the window restarts
 * now, so a streak set for someone who hasn't checked in today isn't lost before they can.
 */
export function setPlan(state: StreakState, n: number, now: number, timeZone: string): StreakState | null {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SET_STREAK) return null;
  if (n === 0) return { count: 0, longest: state.longest, lastActivityAt: null, lastCountedDate: null, startedAt: null };
  const today = localDate(now, timeZone);
  return {
    count: n,
    longest: Math.max(state.longest, n),
    lastActivityAt: now,
    lastCountedDate: today,
    // Midnight-ish of the first day; only used for display.
    startedAt: Date.parse(`${addDays(today, -(n - 1))}T12:00:00Z`) || now,
  };
}

/** "2026-11" in the portal's time zone. */
export function monthKey(now: number, timeZone: string): string {
  return localDate(now, timeZone).slice(0, 7);
}
