import "server-only";
import { holyDayLookup, observesIsraelSchedule } from "@/lib/streak/calendar";
import { localDate } from "@/lib/streak/dates";
import { getStreakStatus, recordActivity, type StreakStatus } from "@/lib/streak/engine";
import { saveStreak, type StreakEvent, type User } from "./users";

export interface StreakCheckIn {
  status: StreakStatus;
  /** What happened to the streak today (started / continued / restarted), if anything. */
  today: StreakEvent | null;
  israel: boolean;
  /** The moment of the check-in. */
  now: number;
}

/** Records that a fully signed-in user showed up, and returns their streak. */
export async function checkIn(user: User, now = Date.now()): Promise<StreakCheckIn> {
  const israel = observesIsraelSchedule(user.timeZone);
  const holyDays = holyDayLookup(israel);
  const result = recordActivity(user.streak, now, user.timeZone, holyDays);
  const date = localDate(now, user.timeZone);

  let today = user.streakLastEvent?.date === date ? user.streakLastEvent : null;
  if (result.outcome !== "same-day") {
    today = { date, outcome: result.outcome, added: result.added, previousCount: result.previousCount };
    await saveStreak(user.id, result.state, today);
  } else if (now - (user.streak.lastActivityAt ?? 0) > 60_000) {
    // Same day: only the deadline moves. Skip the write for reloads seconds apart.
    await saveStreak(user.id, result.state, user.streakLastEvent);
  }

  return { status: getStreakStatus(result.state, now, user.timeZone, holyDays), today, israel, now };
}
