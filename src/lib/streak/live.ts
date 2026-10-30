import { streakCalendar, type Place } from "./calendar";
import { STREAK_WINDOW_HOURS, getStreakStatus, type StreakState } from "./engine";

/**
 * Whether a stored streak is still alive at `now`: the same answer as
 * `getStreakStatus(...).alive`, but anyone who checked in within the window is
 * alive without consulting the calendar (Shabbat and Yom Tov only ever move a
 * deadline later), which is nearly everyone on the board.
 *
 * Kept apart from the ranking code (leaderboard.ts) because it pulls in the whole
 * Hebrew calendar, which the browser doesn't need to show a list.
 */
export function isStreakLive(state: StreakState, place: Place, now: number): boolean {
  if (state.count > 0 && state.lastActivityAt !== null && now - state.lastActivityAt <= STREAK_WINDOW_HOURS * 3_600_000) {
    return true;
  }
  return getStreakStatus(state, now, streakCalendar(place)).alive;
}
