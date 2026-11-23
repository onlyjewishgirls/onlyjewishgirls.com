/**
 * 🔥 Streak rules
 *
 * 0. (Default, PORTAL-STANDARD §4 "Weekend grace and whole days".) Friday and
 *    Sunday are grace days, like Shabbat and Yom Tov, so the required days are
 *    Monday to Thursday minus Yom Tov. The streak lasts until the end of the
 *    next required day in the user's own time zone, and never less than rules
 *    1–2 give: check in any time Thursday, then any time Monday, and it holds.
 *    Checking in on a grace day still counts a day; skipping one costs nothing.
 *    Turning both settings off (HOUR_WINDOW_RULES) leaves exactly rules 1–4.
 * 1. Check in (sign in, or open the site while signed in) at least once every
 *    30 hours.
 * 2. The deadline never falls on Shabbat or Yom Tov, wherever the user is.
 *    When a Shabbat or Yom Tov (including a 2- or 3-day Yom Tov) comes within
 *    the window, the deadline moves to at least 12 hours after it ends. Start
 *    and end come from sunset at the user's location (see calendar.ts).
 * 3. The streak goes up by one for each new calendar day the user checks in on.
 *    Shabbat and Yom Tov days passed over also count, so keeping Shabbat never
 *    costs a day.
 * 4. Miss the deadline and the next check-in starts a new streak at 1.
 */

import type { HolyPeriod, StreakCalendar } from "./calendar";
import { addDays, daysBetween, localDate, startOfDay } from "./dates";

export const STREAK_WINDOW_HOURS = 30;
/** Time guaranteed after Shabbat / Yom Tov ends to check in. */
export const AFTER_HOLY_DAY_HOURS = 12;
export const AT_RISK_HOURS = 4;

const HOUR_MS = 3_600_000;
/**
 * No run of days without a required check-in is longer than 5 (Friday, Shabbat,
 * Sunday, then a 2-day Yom Tov); this just bounds the loops, so a calendar
 * mistake can't hand out unbounded leeway.
 */
const MAX_BLOCK_DAYS = 6;

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

export interface Deadline {
  deadline: number;
  /** Shabbat / Yom Tov (and grace day) periods that pushed the deadline later. */
  leeway: HolyPeriod[];
  /**
   * With whole days: the local date the deadline is the end of ("sign in by the
   * end of Monday"). null when the hour window gave the later deadline.
   */
  dueDate: string | null;
}

/** The next date after `date` that needs a check-in. */
export function nextRequiredDate(date: string, calendar: StreakCalendar): string {
  for (let i = 1; i <= MAX_BLOCK_DAYS; i++) {
    const next = addDays(date, i);
    if (calendar.restricted(next).length === 0) return next;
  }
  // More days in a row than can happen: the calendar is wrong, so cap it.
  return addDays(date, MAX_BLOCK_DAYS + 1);
}

/** When the streak expires if there is no check-in after `lastActivityAt`. */
export function computeDeadline(lastActivityAt: number, calendar: StreakCalendar): Deadline {
  const hours = hourWindowDeadline(lastActivityAt, calendar);
  if (!calendar.rules.calendarDays) return { ...hours, dueDate: null };
  const due = nextRequiredDate(localDate(lastActivityAt, calendar.timeZone), calendar);
  const endOfDue = startOfDay(addDays(due, 1), calendar.timeZone) - 1;
  if (endOfDue <= hours.deadline) return { ...hours, dueDate: null };
  // Every grace period between now and the end of the due date explains why it's that far off.
  const leeway = calendar.periods(lastActivityAt, endOfDue).filter((p) => p.end > lastActivityAt && p.start <= endOfDue);
  return { deadline: endOfDue, leeway, dueDate: due };
}

/** Rules 1–2: 30 hours, moved past Shabbat / Yom Tov (and grace days) that come within it. */
function hourWindowDeadline(lastActivityAt: number, calendar: StreakCalendar): Omit<Deadline, "dueDate"> {
  let deadline = lastActivityAt + STREAK_WINDOW_HOURS * HOUR_MS;
  const leeway: HolyPeriod[] = [];
  // Pushing the deadline can bring another period into range, so repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    for (const period of calendar.periods(lastActivityAt, deadline)) {
      const earliest = period.end + AFTER_HOLY_DAY_HOURS * HOUR_MS;
      // A deadline at the very moment Shabbat / Yom Tov begins counts as falling on it.
      if (period.start <= deadline && earliest > deadline) {
        deadline = earliest;
        if (!leeway.some((p) => p.start === period.start)) leeway.push(period);
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

export function recordActivity(state: StreakState, now: number, calendar: StreakCalendar): ActivityResult {
  const today = localDate(now, calendar.timeZone);
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

  const { deadline } = computeDeadline(state.lastActivityAt, calendar);
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
    if (calendar.holyDays(addDays(state.lastCountedDate, i)).length > 0) added++;
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
  leeway: HolyPeriod[];
  /** The local date the deadline is the end of, with whole days; else null. */
  dueDate: string | null;
}

export function getStreakStatus(state: StreakState, now: number, calendar: StreakCalendar): StreakStatus {
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
      dueDate: null,
    };
  }
  const { deadline, leeway, dueDate } = computeDeadline(state.lastActivityAt, calendar);
  const remainingMs = deadline - now;
  const alive = remainingMs >= 0;
  return {
    count: alive ? state.count : 0,
    longest: state.longest,
    alive,
    deadline,
    remainingMs: alive ? remainingMs : 0,
    atRisk: alive && remainingMs < AT_RISK_HOURS * HOUR_MS,
    checkedInToday: state.lastCountedDate === localDate(now, calendar.timeZone),
    leeway,
    dueDate,
  };
}
