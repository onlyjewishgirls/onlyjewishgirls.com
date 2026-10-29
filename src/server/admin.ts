import "server-only";
import { notFound, redirect } from "next/navigation";
import { EVENT_GROUPS, type EventGroup } from "@/lib/admin/events";
import { isAdminRole } from "@/lib/admin/permissions";
import { streakCalendar } from "@/lib/streak/calendar";
import { bucketByDay, type DailyCount } from "@/lib/admin/days";
import { STREAK_CERTAINLY_OVER_MS, getStreakStatus, type StreakStatus } from "@/lib/streak/engine";
import { all, first, type Param } from "./db";
import { getPageAuth, type PageAuth } from "./guards";
import { jsonError } from "./http";
import { mfaState, nextStep } from "./mfa";
import { storedPlace } from "./location";
import { MFA_FAILURES_PER_HOUR, mfaFailureKey } from "./mfa-routes";
import { isRateLimited } from "./rate-limit";
import { getAuth, listSessions, type AuthContext, type Session } from "./session";

export { recentlyVerified, VERIFY_WINDOW_MS } from "./session";
import { findUserById, listPasskeys, toUser, type Passkey, type User, type UserRow } from "./users";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Matches the sign-in route: 10 wrong passwords in 15 minutes locks the account for a while. */
const LOGIN_ATTEMPTS_PER_WINDOW = 10;
/** Full sessions end after 3 days without activity (see session.ts). */
const IDLE_MS = 3 * DAY;

// ---- Guards ----

/**
 * Admin pages. Anyone who isn't a fully signed-in admin with complete
 * two-step sign-in gets a plain 404, so the panel's existence isn't advertised.
 */
export async function requireAdminPage(): Promise<PageAuth & { now: number }> {
  const auth = await getPageAuth();
  if (!auth) redirect("/login");
  if (auth.next !== "/home") redirect(auth.next);
  if (!isAdminRole(auth.user.role)) notFound();
  // The request's time, for "5 min ago" and streak deadlines (render code stays pure).
  return { ...auth, now: Date.now() };
}

export type AdminApiGuard = { ok: true; ctx: AuthContext } | { ok: false; response: Response };

/**
 * Admin API routes: same rules as the pages. Two-step sign-in must be fully
 * set up and any temporary password replaced before an admin can do anything.
 */
export async function requireAdminApi(): Promise<AdminApiGuard> {
  const ctx = await getAuth();
  if (!ctx || ctx.session.stage !== "full") {
    return { ok: false, response: jsonError(401, "Your sign-in expired. Please sign in again.", { next: "/login" }) };
  }
  if (!isAdminRole(ctx.user.role)) return { ok: false, response: jsonError(404, "Not found.") };
  const next = nextStep(ctx.session.stage, await mfaState(ctx.user), ctx.user.mustChangePassword);
  if (next !== "/home") return { ok: false, response: jsonError(403, "Finish signing in first.", { next }) };
  return { ok: true, ctx };
}

// ---- Shared helpers ----

/** `LIKE` pattern that matches the text literally anywhere. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface AccountLock {
  /** Too many wrong passwords recently. */
  password: boolean;
  /** Too many wrong second-factor attempts in the last hour. */
  twoStep: boolean;
  retryAfterSeconds: number;
}

export async function accountLock(userId: number, now = Date.now()): Promise<AccountLock> {
  const [password, twoStep] = await Promise.all([
    isRateLimited(`login:account:${userId}`, LOGIN_ATTEMPTS_PER_WINDOW, now),
    isRateLimited(mfaFailureKey(userId), MFA_FAILURES_PER_HOUR, now),
  ]);
  return {
    password: password.limited,
    twoStep: twoStep.limited,
    retryAfterSeconds: Math.max(password.retryAfterSeconds, twoStep.retryAfterSeconds),
  };
}

export function streakStatusFor(user: User, now = Date.now()): StreakStatus {
  return getStreakStatus(user.streak, now, streakCalendar(storedPlace(user)));
}

// ---- Dashboard ----

export type { DailyCount } from "@/lib/admin/days";

export interface DashboardStats {
  totalUsers: number;
  newUsers: { day: number; week: number; month: number };
  activeUsers: { day: number; week: number };
  suspended: number;
  admins: number;
  twoStepComplete: number;
  liveSessions: number;
  failedSignIns24h: number;
  lockouts24h: number;
  /** Accounts that can't sign in right now because of too many wrong attempts. */
  lockedNow: number;
  signupsByDay: DailyCount[];
  activeByDay: DailyCount[];
  topStreaks: { user: User; status: StreakStatus }[];
  recentEvents: AdminEvent[];
}

export async function dashboardStats(timeZone: string, now = Date.now()): Promise<DashboardStats> {
  const since = (ms: number) => now - ms;
  const [counts, signups, actives, topRows, recentEvents] = await Promise.all([
    first<{
      total: number;
      new_day: number;
      new_week: number;
      new_month: number;
      active_day: number;
      active_week: number;
      suspended: number;
      admins: number;
      complete: number;
      live_sessions: number;
      failed: number;
      lockouts: number;
      locked_now: number;
    }>(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(created_at >= ?1), 0) AS new_day,
         COALESCE(SUM(created_at >= ?2), 0) AS new_week,
         COALESCE(SUM(created_at >= ?3), 0) AS new_month,
         COALESCE(SUM(MAX(COALESCE(streak_last_activity_at, 0), COALESCE(last_login_at, 0)) >= ?1), 0) AS active_day,
         COALESCE(SUM(MAX(COALESCE(streak_last_activity_at, 0), COALESCE(last_login_at, 0)) >= ?2), 0) AS active_week,
         COALESCE(SUM(suspended_at IS NOT NULL), 0) AS suspended,
         COALESCE(SUM(role IN ('admin', 'owner')), 0) AS admins,
         COALESCE(SUM(totp_enabled_at IS NOT NULL AND recovery_codes_created_at IS NOT NULL
                      AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = users.id)), 0) AS complete,
         (SELECT COUNT(*) FROM sessions WHERE stage = 'full' AND expires_at > ?4 AND last_seen_at > ?5) AS live_sessions,
         (SELECT COUNT(*) FROM events WHERE at >= ?1 AND type IN ('signin.failed', 'signin.unknown', 'signin.mfa_failed')) AS failed,
         (SELECT COUNT(*) FROM events WHERE at >= ?1 AND type IN ('signin.rate_limited', 'signin.mfa_locked')) AS lockouts,
         COALESCE(SUM(EXISTS (SELECT 1 FROM rate_limits r WHERE r.reset_at > ?4
                   AND ((r.key = 'login:account:' || users.id AND r.count >= ?6)
                     OR (r.key = 'mfa-failures:' || users.id AND r.count >= ?7)))), 0) AS locked_now
       FROM users`,
      since(DAY),
      since(7 * DAY),
      since(30 * DAY),
      now,
      since(IDLE_MS),
      LOGIN_ATTEMPTS_PER_WINDOW,
      MFA_FAILURES_PER_HOUR,
    ),
    all<{ created_at: number }>("SELECT created_at FROM users WHERE created_at >= ?", since(31 * DAY)),
    // One row per person per 15 minutes (every time zone's offset is a multiple of 15 minutes,
    // so local days still bucket exactly). Newest first, so a cap could only drop the oldest days.
    all<{ at: number; user_id: number }>(
      `SELECT user_id, MIN(at) AS at FROM events
       WHERE at >= ? AND user_id IS NOT NULL AND (type = 'signin.complete' OR type LIKE 'streak.%')
       GROUP BY user_id, at / 900000
       ORDER BY at DESC
       LIMIT 100000`,
      since(31 * DAY),
    ),
    all<UserRow>(
      `SELECT * FROM users WHERE streak_count > 0 AND streak_last_activity_at >= ?
       ORDER BY streak_count DESC, streak_longest DESC LIMIT 20`,
      now - STREAK_CERTAINLY_OVER_MS,
    ),
    listEvents({ limit: 8 }),
  ]);

  const topStreaks = topRows
    .map((row) => toUser(row)!)
    .map((user) => ({ user, status: streakStatusFor(user, now) }))
    .filter((s) => s.status.alive)
    .slice(0, 5);

  return {
    totalUsers: counts?.total ?? 0,
    newUsers: { day: counts?.new_day ?? 0, week: counts?.new_week ?? 0, month: counts?.new_month ?? 0 },
    activeUsers: { day: counts?.active_day ?? 0, week: counts?.active_week ?? 0 },
    suspended: counts?.suspended ?? 0,
    admins: counts?.admins ?? 0,
    twoStepComplete: counts?.complete ?? 0,
    liveSessions: counts?.live_sessions ?? 0,
    failedSignIns24h: counts?.failed ?? 0,
    lockouts24h: counts?.lockouts ?? 0,
    lockedNow: counts?.locked_now ?? 0,
    signupsByDay: bucketByDay(signups.map((r) => ({ at: r.created_at, key: null })), 30, now, timeZone),
    activeByDay: bucketByDay(actives.map((r) => ({ at: r.at, key: r.user_id })), 30, now, timeZone),
    topStreaks,
    recentEvents: recentEvents.events,
  };
}

// ---- Accounts list ----

export const USER_FILTERS = {
  all: "Everyone",
  active: "Not suspended",
  suspended: "Suspended",
  admins: "Admins",
  incomplete: "Two-step not finished",
  new: "Joined this week",
  locked: "Locked out",
} as const;
export type UserFilter = keyof typeof USER_FILTERS;

export const USER_SORTS = {
  newest: "Newest",
  oldest: "Oldest",
  last_login: "Last sign-in",
  last_active: "Last active",
  streak: "Longest current streak",
  name: "Name",
} as const;
export type UserSort = keyof typeof USER_SORTS;

/** `now` is a number the server computed, never user input. */
const SORT_SQL: Record<UserSort, (now: number) => string> = {
  newest: () => "u.created_at DESC",
  oldest: () => "u.created_at ASC",
  last_login: () => "u.last_login_at IS NULL, u.last_login_at DESC",
  last_active: () => "u.streak_last_activity_at IS NULL, u.streak_last_activity_at DESC",
  // Streaks that can still be alive first; a stored count doesn't drop to 0 until the person comes back.
  streak: (now) =>
    `(COALESCE(u.streak_last_activity_at, 0) >= ${Math.floor(now - STREAK_CERTAINLY_OVER_MS)}) DESC, u.streak_count DESC, u.streak_longest DESC`,
  name: () => "u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE",
};

export const isUserFilter = (value: unknown): value is UserFilter =>
  typeof value === "string" && Object.hasOwn(USER_FILTERS, value);
export const isUserSort = (value: unknown): value is UserSort => typeof value === "string" && Object.hasOwn(USER_SORTS, value);

export interface UserSummary {
  user: User;
  passkeys: number;
  recoveryCodesLeft: number;
  liveSessions: number;
}

export interface UserListResult {
  users: UserSummary[];
  total: number;
  page: number;
  pages: number;
}

export const PAGE_SIZE = 25;

export async function listUsers(
  options: { q?: string; filter?: UserFilter; sort?: UserSort; page?: number },
  now = Date.now(),
): Promise<UserListResult> {
  const where: string[] = [];
  const params: Param[] = [];
  const q = options.q?.trim().toLowerCase();
  if (q) {
    const pattern = contains(q);
    const digits = q.replace(/\D/g, "");
    where.push(
      `(u.search_name LIKE ? ESCAPE '\\'
        OR u.username_lower LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
        ${digits.length >= 3 ? "OR u.phone_e164 LIKE ? ESCAPE '\\'" : ""}
        ${/^\d+$/.test(q) ? "OR u.id = ?" : ""})`,
    );
    params.push(pattern, pattern, pattern);
    if (digits.length >= 3) params.push(contains(digits));
    if (/^\d+$/.test(q)) params.push(Number(q));
  }
  switch (isUserFilter(options.filter) ? options.filter : "all") {
    case "active":
      where.push("u.suspended_at IS NULL");
      break;
    case "suspended":
      where.push("u.suspended_at IS NOT NULL");
      break;
    case "admins":
      where.push("u.role IN ('admin', 'owner')");
      break;
    case "incomplete":
      where.push(
        `NOT (u.totp_enabled_at IS NOT NULL AND u.recovery_codes_created_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id))`,
      );
      break;
    case "new":
      where.push("u.created_at >= ?");
      params.push(now - 7 * DAY);
      break;
    case "locked":
      where.push(
        `EXISTS (SELECT 1 FROM rate_limits r WHERE r.reset_at > ?
                 AND ((r.key = 'login:account:' || u.id AND r.count >= ?)
                   OR (r.key = 'mfa-failures:' || u.id AND r.count >= ?)))`,
      );
      params.push(now, LOGIN_ATTEMPTS_PER_WINDOW, MFA_FAILURES_PER_HOUR);
      break;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await first<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, ...params);
  const total = totalRow?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pages);

  const rows = await all<UserRow & { passkey_count: number; codes_left: number; live_sessions: number }>(
    `SELECT u.*,
       (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count,
       (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS codes_left,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.stage = 'full' AND s.expires_at > ?
          AND s.last_seen_at > ?) AS live_sessions
     FROM users u ${whereSql}
     ORDER BY ${SORT_SQL[isUserSort(options.sort) ? options.sort : "newest"](now)}, u.id DESC
     LIMIT ? OFFSET ?`,
    now,
    now - IDLE_MS,
    ...params,
    PAGE_SIZE,
    (page - 1) * PAGE_SIZE,
  );
  return {
    users: rows.map((row) => ({
      user: toUser(row)!,
      passkeys: row.passkey_count,
      recoveryCodesLeft: row.codes_left,
      liveSessions: row.live_sessions,
    })),
    total,
    page,
    pages,
  };
}

/** Every account, for the CSV export. */
export async function allUsersForExport(): Promise<UserSummary[]> {
  const rows = await all<UserRow & { passkey_count: number; codes_left: number }>(
    `SELECT u.*,
       (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count,
       (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS codes_left
     FROM users u ORDER BY u.id`,
  );
  return rows.map((row) => ({ user: toUser(row)!, passkeys: row.passkey_count, recoveryCodesLeft: row.codes_left, liveSessions: 0 }));
}

// ---- One account ----

export interface UserDetail {
  user: User;
  passkeys: Passkey[];
  recoveryCodesLeft: number;
  sessions: Session[];
  lock: AccountLock;
  streak: StreakStatus;
  failedSignIns24h: number;
  events: AdminEvent[];
}

export async function userDetail(userId: number, now = Date.now()): Promise<UserDetail | null> {
  const user = await findUserById(userId);
  if (!user) return null;
  const [passkeys, codes, sessions, lock, failed, events] = await Promise.all([
    listPasskeys(userId),
    first<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", userId),
    listSessions(userId, now),
    accountLock(userId, now),
    first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND at >= ? AND type IN ('signin.failed', 'signin.mfa_failed')",
      userId,
      now - DAY,
    ),
    listEvents({ userId, limit: 100 }),
  ]);
  return {
    user,
    passkeys,
    recoveryCodesLeft: codes?.n ?? 0,
    sessions: sessions.filter((s) => s.stage === "password" || now - s.lastSeenAt <= IDLE_MS),
    lock,
    streak: streakStatusFor(user, now),
    failedSignIns24h: failed?.n ?? 0,
    events: events.events,
  };
}

// ---- Activity log ----

export interface AdminEvent {
  id: number;
  at: number;
  type: string;
  userId: number | null;
  username: string | null;
  actorId: number | null;
  actorUsername: string | null;
  ip: string | null;
  userAgent: string | null;
  country: string | null;
  detail: Record<string, unknown> | null;
  /** An admin change that can still be undone. */
  undoable: boolean;
  revertedAt: number | null;
  revertedBy: string | null;
}

interface EventRow {
  id: number;
  at: number;
  type: string;
  user_id: number | null;
  username: string | null;
  actor_id: number | null;
  actor_username: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  detail: string | null;
  undo: string | null;
  reverted_at: number | null;
  reverted_by: string | null;
}

function toEvent(row: EventRow): AdminEvent {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = row.detail ? JSON.parse(row.detail) : null;
  } catch {
    detail = null;
  }
  return {
    id: row.id,
    at: row.at,
    type: row.type,
    userId: row.user_id,
    username: row.username,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    ip: row.ip,
    userAgent: row.user_agent,
    country: row.country,
    detail,
    undoable: row.undo !== null && row.reverted_at === null,
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
  };
}

export async function listEvents(options: {
  group?: EventGroup;
  userId?: number;
  q?: string;
  before?: number;
  limit?: number;
}): Promise<{ events: AdminEvent[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: Param[] = [];
  const group = options.group ?? "all";
  if (group === "security") {
    where.push("(type LIKE 'mfa.%' OR type LIKE 'password.%' OR type IN ('signin.mfa_failed', 'signin.mfa_locked'))");
  } else if (EVENT_GROUPS[group].prefix) {
    where.push("type LIKE ?");
    params.push(`${EVENT_GROUPS[group].prefix}%`);
  }
  if (options.userId !== undefined) {
    where.push("(user_id = ? OR actor_id = ?)");
    params.push(options.userId, options.userId);
  }
  const q = options.q?.trim().toLowerCase();
  if (q) {
    where.push("(LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(actor_username) LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')");
    params.push(contains(q), contains(q), contains(q));
  }
  if (options.before !== undefined) {
    where.push("id < ?");
    params.push(options.before);
  }
  const rows = await all<EventRow>(
    `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const events = rows.slice(0, limit).map(toEvent);
  return { events, nextBefore: rows.length > limit ? events[events.length - 1].id : null };
}
