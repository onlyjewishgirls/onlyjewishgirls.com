import "server-only";
import { streakCalendar, type Place } from "@/lib/streak/calendar";
import { localDate } from "@/lib/streak/dates";
import { getStreakStatus, recordActivity, type StreakStatus } from "@/lib/streak/engine";
import { monthKey, restorePlan, setPlan, type RestorePlan } from "@/lib/streak/restore";
import { batch, first } from "./db";
import { logEvent } from "./events";
import { storedPlace, syncPlace } from "./location";
import { getSettings } from "./settings";
import { saveStreak, type StreakEvent, type User } from "./users";

export interface StreakCheckIn {
  status: StreakStatus;
  /** What happened to the streak today (started / continued / restarted), if anything. */
  today: StreakEvent | null;
  place: Place;
  /** The moment of the check-in. */
  now: number;
}

/** Records that a fully signed-in user showed up, and returns their streak. */
export async function checkIn(user: User, now = Date.now()): Promise<StreakCheckIn> {
  const place = await syncPlace(user);
  const calendar = streakCalendar(place);
  const result = recordActivity(user.streak, now, calendar);
  const date = localDate(now, user.timeZone);

  let today = user.streakLastEvent?.date === date ? user.streakLastEvent : null;
  if (result.outcome !== "same-day") {
    today = { date, outcome: result.outcome, added: result.added, previousCount: result.previousCount };
    await saveStreak(user.id, result.state, today);
    await logEvent(`streak.${result.outcome}`, {
      user,
      detail: { count: result.state.count, previous: result.previousCount },
      now,
    });
  } else if (now - (user.streak.lastActivityAt ?? 0) > 60_000) {
    // Same day: only the deadline moves. Skip the write for reloads seconds apart.
    await saveStreak(user.id, result.state, user.streakLastEvent);
  }

  return { status: getStreakStatus(result.state, now, calendar), today, place, now };
}

// ---- Courtesy restores and admin set-streak (PORTAL-STANDARD §4) ----

export interface RestoreQuota {
  month: string;
  /** Monthly allowance from Settings (0 = restores are off). */
  perMonth: number;
  /** Extra restores an admin granted for this month. */
  extra: number;
  used: number;
  left: number;
}

export async function restoreQuota(userId: number, now = Date.now()): Promise<RestoreQuota> {
  const settings = await getSettings();
  const month = monthKey(now, settings.time_zone);
  const [used, grant] = await Promise.all([
    first<{ n: number }>("SELECT COUNT(*) AS n FROM streak_restores WHERE user_id = ? AND month = ? AND kind = 'self'", userId, month),
    first<{ extra: number }>("SELECT extra FROM streak_restore_grants WHERE user_id = ? AND month = ?", userId, month),
  ]);
  const extra = grant?.extra ?? 0;
  const perMonth = settings.streak_restores;
  const allowance = perMonth === 0 ? extra : perMonth + extra;
  return { month, perMonth, extra, used: used?.n ?? 0, left: Math.max(0, allowance - (used?.n ?? 0)) };
}

/** What the user's own restore would do right now, from their stored place. */
export function currentRestorePlan(user: User, now = Date.now()): RestorePlan | null {
  return restorePlan(user.streak, user.streakLastEvent, now, streakCalendar(storedPlace(user)));
}

export type RestoreResult =
  | { ok: true; from: number; to: number; quota: RestoreQuota }
  | { ok: false; code: "nothing_to_restore" | "restores_off" | "no_restores_left"; error: string };

export async function selfRestore(user: User, now = Date.now()): Promise<RestoreResult> {
  const plan = currentRestorePlan(user, now);
  const quota = await restoreQuota(user.id, now);
  const refuse = async (code: "nothing_to_restore" | "restores_off" | "no_restores_left", error: string): Promise<RestoreResult> => {
    await logEvent("streak.restore_refused", { user, detail: { code }, now });
    return { ok: false, code, error };
  };
  if (!plan) return refuse("nothing_to_restore", "Your streak isn't lost, so there's nothing to restore.");
  if (quota.perMonth === 0 && quota.extra === 0) return refuse("restores_off", "Courtesy restores are turned off on this site.");
  if (quota.left === 0) {
    return refuse(
      "no_restores_left",
      `You've used all ${quota.perMonth + quota.extra} courtesy restores for ${quota.month}. They reset at the start of next month.`,
    );
  }
  const event: StreakEvent | null = user.streakLastEvent ? { ...user.streakLastEvent, restored: true } : null;
  await batch([
    [
      `UPDATE users SET streak_count = ?, streak_longest = ?, streak_last_activity_at = ?, streak_last_counted_date = ?,
                        streak_started_at = ?, streak_last_event = ? WHERE id = ?`,
      plan.state.count,
      plan.state.longest,
      plan.state.lastActivityAt,
      plan.state.lastCountedDate,
      plan.state.startedAt,
      event && JSON.stringify(event),
      user.id,
    ],
    [
      `INSERT INTO streak_restores (user_id, by_user_id, kind, from_count, to_count, month, created_at)
       VALUES (?, ?, 'self', ?, ?, ?, ?)`,
      user.id,
      user.id,
      plan.from,
      plan.to,
      quota.month,
      now,
    ],
  ]);
  await logEvent("streak.restored", { user, actor: user, detail: { from: plan.from, to: plan.to, month: quota.month }, now });
  return { ok: true, from: plan.from, to: plan.to, quota: { ...quota, used: quota.used + 1, left: quota.left - 1 } };
}

/**
 * Admin "Set streak to N". Uses setPlan; never consumes the target's courtesy restores.
 * Logged in streak_restores (kind 'admin'), the audit log, and a security alert (via the audit event).
 * Permission checks are the caller's (see can() in lib/admin/permissions.ts).
 */
export async function adminSetStreak(actor: User, target: User, n: number, now = Date.now()) {
  const settings = await getSettings();
  const state = setPlan(target.streak, n, now, target.timeZone);
  if (!state) return null;
  const from = streakStatusOf(target, now).count;
  await batch([
    [
      `UPDATE users SET streak_count = ?, streak_longest = ?, streak_last_activity_at = ?, streak_last_counted_date = ?,
                        streak_started_at = ?, streak_last_event = NULL WHERE id = ?`,
      state.count,
      state.longest,
      state.lastActivityAt,
      state.lastCountedDate,
      state.startedAt,
      target.id,
    ],
    [
      `INSERT INTO streak_restores (user_id, by_user_id, kind, from_count, to_count, month, created_at)
       VALUES (?, ?, 'admin', ?, ?, ?, ?)`,
      target.id,
      actor.id,
      from,
      n,
      monthKey(now, settings.time_zone),
      now,
    ],
  ]);
  return { from, to: n, state };
}

export async function grantRestores(actor: User, target: User, extra: number, now = Date.now()) {
  const settings = await getSettings();
  const month = monthKey(now, settings.time_zone);
  await batch([
    [
      `INSERT INTO streak_restore_grants (user_id, month, extra) VALUES (?, ?, ?)
       ON CONFLICT(user_id, month) DO UPDATE SET extra = extra + excluded.extra`,
      target.id,
      month,
      extra,
    ],
    [
      `INSERT INTO streak_restores (user_id, by_user_id, kind, from_count, to_count, month, created_at)
       VALUES (?, ?, 'grant', 0, ?, ?, ?)`,
      target.id,
      actor.id,
      extra,
      month,
      now,
    ],
  ]);
  return restoreQuota(target.id, now);
}

export function streakStatusOf(user: User, now = Date.now()): StreakStatus {
  return getStreakStatus(user.streak, now, streakCalendar(storedPlace(user)));
}
