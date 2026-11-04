import "server-only";
import { randomBytes } from "node:crypto";
import parseMax from "libphonenumber-js/max";
import { describeDevice, fullName } from "@/lib/admin/format";
import {
  allowedActions,
  can,
  canCreate,
  EXTRA_PERMISSIONS,
  isExtraPermission,
  isRole,
  ROLE_LABELS,
  type AdminAction,
} from "@/lib/admin/permissions";
import { sortMfa, type MfaKind } from "@/lib/mfa-order";
import { MAX_SET_STREAK } from "@/lib/streak/restore";
import { normalizeEmail, normalizeName, validateEmail, validateName, validatePhone, validateUsername } from "@/lib/validation";
import { accountLock, listEvents } from "../admin";
import { profileOf } from "../admin-undo";
import { all, first, type Param } from "../db";
import { APP_NAME, isLocalHost } from "../env";
import { logEvent } from "../events";
import { matchingRules } from "../ip-rules";
import { LOGIN_ATTEMPTS_PER_WINDOW, loginAccountKey } from "../login-rules";
import { deliverEmail, simpleHtml } from "../mailer";
import { MFA_FAILURES_PER_HOUR, mfaFailureKey } from "../mfa-routes";
import { sendPasswordResetEmail } from "../password-reset";
import { hashPassword } from "../passwords";
import { resetRateLimit } from "../rate-limit";
import { listSessions } from "../session";
import { adminSetStreak, currentRestorePlan, grantRestores, restoreQuota, streakStatusOf } from "../streak";
import { generateTemporaryPassword } from "../temp-password";
import {
  createUser,
  deleteSession,
  deleteSessions,
  deleteUser,
  disableTotp,
  emailTaken,
  findUserById,
  listPasskeys,
  removePasskey,
  resetTwoStep,
  setAdminLock,
  setAdminNote,
  setMustChangePassword,
  setPermissions,
  setRole,
  setTemporaryPassword,
  suspendUser,
  toUser,
  unsuspendUser,
  updateProfile,
  usernameTaken,
  type ProfileChanges,
  type User,
  type UserRow,
} from "../users";
import { bodyStr, err, idParam, iso, json, need, pageParams, personRef, roleRef, type ConsoleCtx } from "./core";
import { auditEntry } from "./records";

const IDLE_MS = 3 * 86_400_000;
const FOREVER = 8.64e15;

// ---- Summaries ----

interface Extras {
  passkeys: number;
  live: number;
  lockedByRate: boolean;
}

function statusOf(u: User, extras: Pick<Extras, "lockedByRate">, now: number) {
  if (u.suspendedAt !== null) return "suspended";
  if ((u.lockedUntil !== null && u.lockedUntil > now) || extras.lockedByRate) return "locked";
  return "active";
}

function mfaKinds(u: User, passkeys: number): MfaKind[] {
  const kinds: MfaKind[] = [];
  if (passkeys > 0) kinds.push("passkey");
  if (u.totpEnabledAt !== null) kinds.push("totp");
  if (u.recoveryCodesCreatedAt !== null) kinds.push("recovery");
  return sortMfa(kinds);
}

export function summary(u: User, extras: Extras, now: number) {
  const status = statusOf(u, extras, now);
  const streak = streakStatusOf(u, now);
  const complete = extras.passkeys > 0 && u.totpEnabledAt !== null && u.recoveryCodesCreatedAt !== null;
  const flags: string[] = [];
  if (u.mustChangePassword) flags.push("must_change_password");
  if (status === "locked") flags.push("locked");
  if (!complete) flags.push("mfa_missing");
  return {
    id: String(u.id),
    name: fullName(u),
    username: u.username,
    email: u.email,
    phone: u.phone,
    staff_id: String(u.id),
    role: roleRef(u),
    status,
    online: extras.live > 0,
    last_seen_at: iso(Math.max(u.lastLoginAt ?? 0, u.streak.lastActivityAt ?? 0) || null),
    last_login_at: iso(u.lastLoginAt),
    created_at: iso(u.createdAt),
    mfa: mfaKinds(u, extras.passkeys),
    streak: { current: streak.count, longest: streak.longest, alive: streak.alive },
    flags,
  };
}

const LOCK_SQL = `EXISTS (SELECT 1 FROM rate_limits r WHERE r.reset_at > ?
  AND ((r.key = 'login:account:' || u.id AND r.count >= ${LOGIN_ATTEMPTS_PER_WINDOW})
    OR (r.key = 'mfa-failures:' || u.id AND r.count >= ${MFA_FAILURES_PER_HOUR})))`;

export async function listPeople(ctx: ConsoleCtx) {
  need(ctx, "people.view");
  const { limit, offset } = pageParams(ctx);
  const now = ctx.now;
  const where: string[] = [];
  const params: Param[] = [];
  const q = ctx.query.get("q")?.trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = q.replace(/\D/g, "");
    where.push(
      `(u.search_name LIKE ? ESCAPE '\\' OR u.username_lower LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
        ${digits.length >= 3 ? "OR u.phone_e164 LIKE ?" : ""} ${/^\d+$/.test(q) ? "OR u.id = ?" : ""})`,
    );
    params.push(like, like, like);
    if (digits.length >= 3) params.push(`%${digits}%`);
    if (/^\d+$/.test(q)) params.push(Number(q));
  }
  const status = ctx.query.get("status");
  if (status === "suspended") where.push("u.suspended_at IS NOT NULL");
  if (status === "active") {
    where.push(`u.suspended_at IS NULL AND (u.locked_until IS NULL OR u.locked_until <= ?) AND NOT ${LOCK_SQL}`);
    params.push(now, now);
  }
  if (status === "locked") {
    where.push(`u.suspended_at IS NULL AND ((u.locked_until IS NOT NULL AND u.locked_until > ?) OR ${LOCK_SQL})`);
    params.push(now, now);
  }
  const role = ctx.query.get("role");
  if (role && isRole(role)) {
    where.push("u.role = ?");
    params.push(role);
  }
  const flag = ctx.query.get("flag");
  if (flag === "mfa_missing") {
    where.push(`NOT (u.totp_enabled_at IS NOT NULL AND u.recovery_codes_created_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id))`);
  }
  if (flag === "must_change") where.push("u.must_change_password = 1");
  if (flag === "locked") {
    where.push(`((u.locked_until IS NOT NULL AND u.locked_until > ?) OR ${LOCK_SQL})`);
    params.push(now, now);
  }
  if (flag === "online") {
    where.push("EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.stage = 'full' AND s.expires_at > ? AND s.last_seen_at > ?)");
    params.push(now, now - IDLE_MS);
  }
  const sort = ctx.query.get("sort");
  const order =
    sort === "name"
      ? "u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE"
      : sort === "last_seen"
        ? "MAX(COALESCE(u.last_login_at, 0), COALESCE(u.streak_last_activity_at, 0)) DESC"
        : "u.created_at DESC";
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await first<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, ...params))?.n ?? 0;
  const rows = await all<UserRow & { passkey_count: number; live: number; rate_locked: number }>(
    `SELECT u.*,
       (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.stage = 'full' AND s.expires_at > ? AND s.last_seen_at > ?) AS live,
       ${LOCK_SQL} AS rate_locked
     FROM users u ${whereSql} ORDER BY ${order}, u.id DESC LIMIT ? OFFSET ?`,
    now,
    now - IDLE_MS,
    now,
    ...params,
    limit,
    offset,
  );
  return json({
    total,
    next_cursor: offset + rows.length < total ? String(offset + rows.length) : null,
    items: rows.map((r) => summary(toUser(r)!, { passkeys: r.passkey_count, live: r.live, lockedByRate: r.rate_locked === 1 }, now)),
    filters: {
      statuses: [
        { value: "active", label: "Active" },
        { value: "locked", label: "Locked" },
        { value: "suspended", label: "Suspended" },
      ],
      roles: (["member", "admin", "owner"] as const).map((r) => ({ value: r, label: ROLE_LABELS[r] })),
    },
  });
}

// ---- The record ----

async function loadTarget(ctx: ConsoleCtx): Promise<User> {
  const user = await findUserById(idParam(ctx));
  if (!user) throw err(404, "not_found", `There is no account with id ${ctx.params.id}.`);
  return user;
}

const SELF_REASONS: Partial<Record<AdminAction, string>> = {
  suspend: "You can't suspend your own account.",
  unsuspend: "You can't change your own account's status.",
  delete: "You can't delete your own account.",
  set_role: "You can't change your own role.",
  set_temp_password: "Change your own password from your account page.",
  reset_two_step: "You can't reset your own two-step sign-in here.",
  remove_passkey: "You can't remove your own passkeys here.",
  disable_totp: "You can't turn off your own authenticator app here.",
  lock: "You can't lock your own account.",
  set_permissions: "You can't change your own permissions.",
  force_change: "Change your own password from your account page.",
  set_streak: "Only the owner can set their own streak.",
  grant_restores: "Only the owner can grant restores to themselves.",
};

function reasonFor(ctx: ConsoleCtx, action: AdminAction, target: User): string {
  if (ctx.me.id === target.id) return SELF_REASONS[action] ?? "Not on your own account.";
  if (target.role === "owner") return "Nobody can change the owner's account from the console.";
  if ((action === "set_streak" || action === "grant_restores") && !ctx.caps.has("streaks.manage")) {
    return "You need the streaks.manage permission (the owner can grant it).";
  }
  if (target.role === "admin") return "Only the owner can change admin accounts.";
  if (action === "set_role" || action === "set_permissions") return "Only the owner can change roles and permissions.";
  return "You don't have permission.";
}

function actionsFor(ctx: ConsoleCtx, target: User, status: string) {
  const allowed = new Set(allowedActions(ctx.me, target));
  const a = (site: AdminAction, extra?: { when?: boolean; reason?: string }) => {
    if (extra?.when === false) return { allowed: false, reason: extra.reason };
    return allowed.has(site) ? { allowed: true } : { allowed: false, reason: reasonFor(ctx, site, target) };
  };
  return {
    edit: a("edit_profile"),
    role: a("set_role"),
    permissions: a("set_permissions"),
    activate: a("unsuspend", { when: status === "suspended", reason: "The account isn't suspended." }),
    suspend: a("suspend", { when: status !== "suspended", reason: "Already suspended." }),
    lock: a("lock"),
    unlock: a("unlock_sign_in"),
    delete: a("delete"),
    reset_password: a("set_temp_password"),
    force_change: a("force_change"),
    mfa_reset: a("reset_two_step"),
    passkey_remove: a("remove_passkey"),
    totp_reset: a("disable_totp", { when: target.totpEnabledAt !== null, reason: "No authenticator app is connected." }),
    sessions_revoke: a("sign_out_everywhere"),
    ip_allow: ctx.caps.has("ips.manage") ? { allowed: true } : { allowed: false, reason: "Only the owner manages the IP lists." },
    ip_block: ctx.caps.has("ips.manage") ? { allowed: true } : { allowed: false, reason: "Only the owner manages the IP lists." },
    streak_set: a("set_streak"),
    streak_grant: a("grant_restores"),
    email: a("send_email"),
  };
}

export async function streakView(target: User, now: number) {
  const status = streakStatusOf(target, now);
  const [quota, plan] = [await restoreQuota(target.id, now), currentRestorePlan(target, now)];
  return {
    current: status.count,
    longest: status.longest,
    alive: status.alive,
    deadline: iso(status.deadline),
    expires_at: iso(status.deadline),
    leeway_for: status.leeway.map((l) => l.names.join(" · ")),
    hours_left: status.remainingMs === null ? null : Math.round((status.remainingMs / 3_600_000) * 10) / 10,
    restores_used: quota.used,
    restores_left: quota.left,
    restores_per_month: quota.perMonth,
    restores_extra: quota.extra,
    restore_to: plan?.to ?? null,
    month: quota.month,
  };
}

export async function getPerson(ctx: ConsoleCtx) {
  need(ctx, "people.view");
  const target = await loadTarget(ctx);
  const now = ctx.now;
  const [passkeys, sessions, lock, events, codes, ips] = await Promise.all([
    listPasskeys(target.id),
    listSessions(target.id, now),
    accountLock(target.id, now),
    listEvents({ userId: target.id, limit: 50 }),
    first<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", target.id),
    all<{ ip: string; last: number; n: number }>(
      `SELECT ip, MAX(at) AS last, COUNT(*) AS n FROM events WHERE user_id = ? AND ip IS NOT NULL AND type = 'signin.complete'
       GROUP BY ip ORDER BY last DESC LIMIT 20`,
      target.id,
    ),
  ]);
  const live = sessions.filter((s) => s.stage === "full" && now - s.lastSeenAt <= IDLE_MS);
  const status = statusOf(target, { lockedByRate: lock.password || lock.twoStep }, now);
  const failed = await first<{ count: number }>("SELECT count FROM rate_limits WHERE key = ? AND reset_at > ?", loginAccountKey(target.id), now);
  const ipRows = await Promise.all(
    ips.map(async (row) => {
      const [allow, deny] = await Promise.all([matchingRules(row.ip, "allow", now), matchingRules(row.ip, "deny", now)]);
      return {
        id: allow[0] ? String(allow[0].id) : `ip:${row.ip}`,
        ip_or_cidr: row.ip,
        label: `${row.n} sign-in${row.n === 1 ? "" : "s"}, last ${new Date(row.last).toISOString().slice(0, 10)}`,
        status: deny.length ? "revoked" : allow.length ? "active" : "expired",
        note: deny.length ? `Blocked: ${deny[0].reason ?? "deny list"}` : allow.length ? "On the allowlist" : "Not on the allowlist",
        created_at: iso(row.last),
      };
    }),
  );
  const ownerEdits = ctx.isOwner && ctx.me.id !== target.id && target.role !== "owner";
  return json({
    person: {
      ...summary(target, { passkeys: passkeys.length, live: live.length, lockedByRate: lock.password || lock.twoStep }, now),
      notes: target.adminNote,
      locked_until: target.lockedUntil && target.lockedUntil > now ? (target.lockedUntil >= FOREVER ? null : iso(target.lockedUntil)) : lock.password || lock.twoStep ? iso(now + lock.retryAfterSeconds * 1000) : null,
      must_change_password: target.mustChangePassword,
      failed_logins: failed?.count ?? 0,
      last_login_ip: live[0]?.ip ?? ips[0]?.ip ?? null,
      status_reason: target.suspendedReason ?? target.lockedReason ?? (lock.password ? "Too many wrong passwords" : lock.twoStep ? "Too many wrong two-step codes" : null),
      time_zone: target.timeZone,
      country: target.country,
    },
    fields: [
      { key: "first_name", label: "First name", type: "text", value: target.firstName, maxlength: 60 },
      { key: "middle_name", label: "Middle name", type: "text", value: target.middleName ?? "", optional: true, maxlength: 60 },
      { key: "last_name", label: "Last name", type: "text", value: target.lastName, maxlength: 60 },
      { key: "username", label: "Username", type: "text", value: target.username, maxlength: 30 },
      { key: "email", label: "Email", type: "email", value: target.email },
      { key: "phone", label: "Mobile (with country code)", type: "tel", value: target.phone, placeholder: "+12125551234" },
      { key: "staff_id", label: "Account ID", type: "text", value: String(target.id), editable: false },
      { key: "notes", label: "Admin note (only admins see it)", type: "textarea", value: target.adminNote ?? "", optional: true, maxlength: 2000 },
    ],
    access: {
      roles: [{ id: target.role, name: ROLE_LABELS[target.role] }],
      role_options: [
        { id: "member", name: "Member", rank: 10 },
        { id: "admin", name: "Admin", rank: 50 },
      ],
      multi: false,
      editable: can(ctx.me, "set_role", target),
      note:
        target.role === "owner"
          ? "There is one owner (set in the database). The owner's role can't be changed here."
          : "Admins see everything and manage members. Only the owner manages admins.",
    },
    permissions: {
      mode: "flags",
      editable: ownerEdits,
      note: "Extra permissions on top of the role. The owner always has every permission.",
      catalog: Object.entries(EXTRA_PERMISSIONS).map(([key, label]) => ({ key, label, group: "Streaks", danger: false })),
      effective: Object.keys(EXTRA_PERMISSIONS).map((key) => ({
        key,
        granted: target.role === "owner" || target.permissions.includes(key),
        source: target.role === "owner" ? "account" : target.permissions.includes(key) ? "flag" : "role",
      })),
      grants: target.permissions,
      denies: [],
    },
    mfa: {
      required: true,
      required_source: "policy",
      require_editable: false,
      methods: [
        {
          kind: "passkey",
          label: "Passkeys",
          enrolled: passkeys.length > 0,
          items: passkeys.map((p) => ({
            id: p.id,
            label: `${p.deviceType === "multiDevice" ? "Synced passkey" : "Device-bound passkey"}${p.backedUp ? " (backed up)" : ""}`,
            created_at: iso(p.createdAt),
            last_used_at: iso(p.lastUsedAt),
          })),
        },
        { kind: "totp", label: "Authenticator app", enrolled: target.totpEnabledAt !== null, created_at: iso(target.totpEnabledAt) },
        {
          kind: "recovery",
          label: `Recovery codes (${codes?.n ?? 0} unused)`,
          enrolled: target.recoveryCodesCreatedAt !== null,
          created_at: iso(target.recoveryCodesCreatedAt),
        },
      ],
    },
    sessions: sessions.map((s) => sessionEntry(s, target, ctx.auth.session.idHash, now)),
    ips: ipRows,
    streak: await streakView(target, now),
    activity: events.events.map(auditEntry),
    actions: actionsFor(ctx, target, status),
  });
}

export function sessionEntry(
  s: Awaited<ReturnType<typeof listSessions>>[number],
  user: Pick<User, "id" | "username" | "firstName" | "lastName">,
  currentIdHash: string,
  now: number,
) {
  return {
    id: s.idHash.slice(0, 32),
    person: personRef(user),
    ip: s.ip,
    city: s.city,
    country: s.country,
    device: s.userAgent ? { id: s.idHash.slice(0, 12), label: describeDevice(s.userAgent) } : null,
    user_agent: s.userAgent,
    created_at: iso(s.createdAt),
    last_seen_at: iso(s.lastSeenAt),
    expires_at: iso(s.expiresAt),
    active: s.expiresAt > now && (s.stage === "password" || now - s.lastSeenAt <= IDLE_MS),
    current: s.idHash === currentIdHash,
    mfa: s.stage === "password" ? "pending" : undefined,
  };
}

// ---- Record actions ----

function requireAction(ctx: ConsoleCtx, action: AdminAction, target: User) {
  if (!can(ctx.me, action, target)) throw err(403, "forbidden", reasonFor(ctx, action, target));
}

async function audited(
  ctx: ConsoleCtx,
  type: Parameters<typeof logEvent>[0],
  target: User,
  detail?: Record<string, unknown>,
  undo?: Record<string, unknown>,
) {
  return logEvent(type, { user: target, actor: ctx.me, detail, undo, now: ctx.now });
}

type Fields = Record<string, string>;

export async function patchPerson(ctx: ConsoleCtx) {
  need(ctx, "people.edit");
  const target = await loadTarget(ctx);
  requireAction(ctx, "edit_profile", target);
  const b = ctx.body;
  const has = (k: string) => Object.hasOwn(b, k);
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : String(b[k] ?? ""));

  if (has("notes") && Object.keys(b).length === 1) {
    const note = s("notes").trim().slice(0, 2000) || null;
    if (note !== target.adminNote) {
      await setAdminNote(target.id, note);
      await audited(ctx, "admin.set_note", target, undefined, { kind: "set_note", note: target.adminNote, after: { note } });
    }
    return json({ person: await freshSummary(target.id, ctx.now) });
  }

  const input = {
    firstName: has("first_name") ? s("first_name") : target.firstName,
    middleName: has("middle_name") ? s("middle_name") : (target.middleName ?? ""),
    lastName: has("last_name") ? s("last_name") : target.lastName,
    email: has("email") ? s("email") : target.email,
    username: has("username") ? s("username").trim() : target.username,
    phone: has("phone") ? s("phone").trim() : target.phone,
  };
  const fields: Fields = {};
  const set = (key: string, e: string | undefined) => e && (fields[key] = e);
  set("first_name", validateName(input.firstName, "First name"));
  if (input.middleName.trim()) set("middle_name", validateName(input.middleName, "Middle name"));
  set("last_name", validateName(input.lastName, "Last name"));
  set("email", validateEmail(input.email));
  set("username", validateUsername(input.username));
  const country = input.phone.startsWith("+") ? undefined : "US";
  set("phone", validatePhone(input.phone, country ?? "US"));
  const email = normalizeEmail(input.email);
  const phone = parseMax(input.phone, country as Parameters<typeof parseMax>[1]);
  if (!fields.phone && !phone) fields.phone = "That isn't a valid mobile number. Include the country code, e.g. +12125551234.";
  if (!fields.username && (await first("SELECT 1 FROM users WHERE username_lower = ? AND id != ?", input.username.toLowerCase(), target.id))) {
    fields.username = `The username "${input.username}" is taken by another account.`;
  }
  if (!fields.email && (await first("SELECT 1 FROM users WHERE email = ? AND id != ?", email, target.id))) {
    fields.email = `Another account already uses ${email}.`;
  }
  if (Object.keys(fields).length) {
    const [field] = Object.keys(fields);
    throw err(400, "validation", fields[field], { field, fields });
  }
  const changes: ProfileChanges = {
    firstName: normalizeName(input.firstName),
    middleName: input.middleName.trim() ? normalizeName(input.middleName) : null,
    lastName: normalizeName(input.lastName),
    email,
    username: input.username,
    phone: phone!.number,
  };
  const changed = (Object.keys(changes) as (keyof ProfileChanges)[]).filter((k) => changes[k] !== target[k]);
  if (changed.length) {
    await updateProfile(target.id, changes);
    await audited(ctx, "admin.edit_profile", target, { changed }, { kind: "edit_profile", profile: profileOf(target), after: changes });
  }
  if (has("notes")) {
    const note = s("notes").trim().slice(0, 2000) || null;
    if (note !== target.adminNote) {
      await setAdminNote(target.id, note);
      await audited(ctx, "admin.set_note", target, undefined, { kind: "set_note", note: target.adminNote, after: { note } });
    }
  }
  return json({ person: await freshSummary(target.id, ctx.now) });
}

async function freshSummary(id: number, now: number) {
  const u = (await findUserById(id))!;
  const [pk, lock] = await Promise.all([listPasskeys(id), accountLock(id, now)]);
  const live = (await listSessions(id, now)).filter((s) => s.stage === "full" && now - s.lastSeenAt <= IDLE_MS).length;
  return summary(u, { passkeys: pk.length, live, lockedByRate: lock.password || lock.twoStep }, now);
}

export async function createPerson(ctx: ConsoleCtx) {
  need(ctx, "people.create");
  const b = ctx.body;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const role = isRole(b.role) ? b.role : "member";
  if (!canCreate(ctx.me, role)) throw err(403, "forbidden", role === "owner" ? "Nobody can create another owner." : "Only the owner can create admin accounts.");
  // The kit's default form sends `name`; split it into first/last when first_name isn't given.
  let firstName = s("first_name");
  let lastName = s("last_name");
  if (!firstName && s("name")) {
    const parts = s("name").trim().split(/\s+/);
    firstName = parts[0] ?? "";
    lastName = parts.slice(1).join(" ");
  }
  const input = { firstName, middleName: s("middle_name"), lastName, email: s("email"), username: s("username").trim(), phone: s("phone").trim() };
  const fields: Fields = {};
  const set = (key: string, e: string | undefined) => e && (fields[key] = e);
  set("first_name", validateName(input.firstName, "First name"));
  if (input.middleName.trim()) set("middle_name", validateName(input.middleName, "Middle name"));
  set("last_name", validateName(input.lastName, "Last name"));
  if (!firstName && fields.first_name) fields.name = fields.first_name;
  if (lastName === "" && s("name")) fields.name = "Enter a first and last name.";
  set("email", validateEmail(input.email));
  set("username", validateUsername(input.username));
  set("phone", validatePhone(input.phone, "US"));
  const email = normalizeEmail(input.email);
  const phone = parseMax(input.phone, input.phone.startsWith("+") ? undefined : "US");
  if (!fields.phone && !phone) fields.phone = "That isn't a valid mobile number. Include the country code.";
  if (!fields.username && (await usernameTaken(input.username))) fields.username = `The username "${input.username}" is taken.`;
  if (!fields.email && (await emailTaken(email))) fields.email = `An account with ${email} already exists.`;
  if (Object.keys(fields).length) {
    const [field] = Object.keys(fields);
    throw err(400, "validation", fields[field], { field, fields });
  }
  const person = {
    firstName: normalizeName(input.firstName),
    middleName: input.middleName.trim() ? normalizeName(input.middleName) : null,
    lastName: normalizeName(input.lastName),
    email,
    username: input.username,
    phone: phone!.number,
  };
  const temporaryPassword = generateTemporaryPassword({ ...person, middleName: person.middleName ?? "" });
  let userId: number;
  try {
    userId = await createUser(
      { ...person, passwordHash: await hashPassword(temporaryPassword), timeZone: ctx.me.timeZone, webauthnUserId: randomBytes(32).toString("base64url") },
      ctx.now,
      { role, mustChangePassword: true },
    );
  } catch (e) {
    if (/UNIQUE constraint failed/.test(String((e as Error)?.message))) throw err(409, "conflict", "That username or email was just taken. Try another.");
    throw e;
  }
  await logEvent("admin.create_account", { user: { id: userId, username: person.username }, actor: ctx.me, detail: { role }, now: ctx.now });
  return json({ person: await freshSummary(userId, ctx.now), temporary_password: temporaryPassword }, 201);
}

export async function deletePerson(ctx: ConsoleCtx) {
  need(ctx, "people.delete");
  const target = await loadTarget(ctx);
  if (target.role === "owner") throw err(400, "last_owner", "The owner's account can't be deleted.");
  requireAction(ctx, "delete", target);
  await audited(ctx, "admin.delete", target);
  await deleteUser(target.id);
  return json({});
}

export async function setPersonRoles(ctx: ConsoleCtx) {
  need(ctx, "people.role");
  const target = await loadTarget(ctx);
  if (target.role === "owner") throw err(400, "last_owner", "The owner can't be demoted; there must always be one owner.");
  requireAction(ctx, "set_role", target);
  const ids = Array.isArray(ctx.body.role_ids) ? ctx.body.role_ids : [ctx.body.value ?? ctx.body.role];
  const role = ids[0];
  if (ids.length !== 1 || (role !== "member" && role !== "admin")) throw err(400, "validation", "Pick exactly one role: Member or Admin.", { field: "role_ids" });
  if (role !== target.role) {
    await setRole(target.id, role);
    await audited(ctx, "admin.set_role", target, { from: target.role, to: role }, { kind: "set_role", role: target.role, after: { role } });
  }
  return json({});
}

export async function setPersonPermissions(ctx: ConsoleCtx) {
  need(ctx, "people.permissions");
  const target = await loadTarget(ctx);
  requireAction(ctx, "set_permissions", target);
  const raw = Array.isArray(ctx.body.permissions) ? ctx.body.permissions : Array.isArray(ctx.body.grants) ? ctx.body.grants : null;
  if (!raw) throw err(400, "validation", "Send the full list of permissions.", { field: "permissions" });
  const unknown = raw.filter((p) => !isExtraPermission(p));
  if (unknown.length) throw err(400, "validation", `Unknown permission: ${unknown.join(", ")}.`);
  const next = [...new Set(raw as string[])].sort();
  await setPermissions(target.id, next);
  await audited(ctx, "admin.set_permissions", target, { from: target.permissions.join(",") || "none", to: next.join(",") || "none" });
  return json({});
}

export async function setPersonStatus(ctx: ConsoleCtx) {
  need(ctx, "people.status");
  const target = await loadTarget(ctx);
  const status = bodyStr(ctx, "status");
  const reason = bodyStr(ctx, "reason").trim().slice(0, 500) || null;
  if (status === "suspended") {
    if (target.role === "owner") throw err(400, "last_owner", "The owner can't be suspended.");
    requireAction(ctx, "suspend", target);
    if (target.suspendedAt !== null) throw err(409, "conflict", `${target.username} is already suspended.`);
    await suspendUser(target.id, reason, ctx.now);
    await audited(ctx, "admin.suspend", target, { reason }, { kind: "unsuspend", after: { suspendedAt: ctx.now } });
    return json({ status: "suspended" });
  }
  if (status === "active") {
    requireAction(ctx, "unsuspend", target);
    if (target.suspendedAt === null && !(target.lockedUntil && target.lockedUntil > ctx.now)) return json({ status: "active" });
    if (target.suspendedAt !== null) {
      await unsuspendUser(target.id);
      await audited(ctx, "admin.unsuspend", target, undefined, { kind: "suspend", suspendedAt: target.suspendedAt, reason: target.suspendedReason });
    }
    if (target.lockedUntil) {
      await setAdminLock(target.id, null, null);
      await audited(ctx, "admin.unlock", target);
    }
    return json({ status: "active" });
  }
  throw err(400, "validation", `"${status}" isn't a status here. This site has active and suspended (plus lock/unlock).`, { field: "status" });
}

export async function lockPerson(ctx: ConsoleCtx) {
  need(ctx, "people.status");
  const target = await loadTarget(ctx);
  requireAction(ctx, "lock", target);
  const minutes = ctx.body.minutes === null || ctx.body.minutes === undefined ? null : Number(ctx.body.minutes);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600)) {
    throw err(400, "validation", "Minutes must be a whole number from 1 to 525600, or empty for until unlocked.", { field: "minutes" });
  }
  const until = minutes === null ? FOREVER : ctx.now + minutes * 60_000;
  const reason = bodyStr(ctx, "reason").trim().slice(0, 500) || null;
  await setAdminLock(target.id, until, reason);
  await audited(ctx, "admin.lock", target, { minutes, reason });
  return json({ locked_until: minutes === null ? null : iso(until) });
}

export async function unlockPerson(ctx: ConsoleCtx) {
  need(ctx, "people.status");
  const target = await loadTarget(ctx);
  requireAction(ctx, "unlock_sign_in", target);
  await resetRateLimit(loginAccountKey(target.id));
  await resetRateLimit(mfaFailureKey(target.id));
  if (target.lockedUntil !== null) await setAdminLock(target.id, null, null);
  await audited(ctx, "admin.unlock", target);
  return json({});
}

export async function resetPassword(ctx: ConsoleCtx) {
  need(ctx, "people.password");
  const target = await loadTarget(ctx);
  const mode = bodyStr(ctx, "mode") || "temporary";
  if (mode === "link") {
    requireAction(ctx, "send_password_reset", target);
    if (target.suspendedAt !== null) throw err(409, "conflict", "Lift the suspension first. Reset links don't work on suspended accounts.");
    await sendPasswordResetEmail(ctx.req, target, ctx.now);
    await audited(ctx, "admin.send_password_reset", target);
    return json({ emailed: true, note: `Sent a reset link to ${target.email}. It works once and expires in 30 minutes.` });
  }
  if (mode === "set") {
    throw err(501, "unsupported", "Setting a chosen password isn't supported here: use a temporary password (shown once) or an emailed link.");
  }
  requireAction(ctx, "set_temp_password", target);
  const password = generateTemporaryPassword({
    firstName: target.firstName,
    middleName: target.middleName ?? "",
    lastName: target.lastName,
    username: target.username,
    email: target.email,
    phone: target.phone,
  });
  await setTemporaryPassword(target.id, await hashPassword(password));
  await audited(ctx, "admin.set_temp_password", target);
  // A temporary password always forces a change at next sign-in on this site.
  return json({ temporary_password: password });
}

export async function forceChange(ctx: ConsoleCtx) {
  need(ctx, "people.password");
  const target = await loadTarget(ctx);
  requireAction(ctx, "force_change", target);
  const on = ctx.body.on === true;
  await setMustChangePassword(target.id, on);
  await audited(ctx, "admin.force_change", target, { on });
  return json({});
}

export async function resetMfa(ctx: ConsoleCtx) {
  need(ctx, "people.mfa");
  const target = await loadTarget(ctx);
  requireAction(ctx, "reset_two_step", target);
  await resetTwoStep(target.id);
  await audited(ctx, "admin.reset_two_step", target);
  return json({ cleared: ["passkey", "totp", "recovery"], falls_back_to: "setup" });
}

export async function removePersonPasskey(ctx: ConsoleCtx) {
  need(ctx, "people.mfa");
  const target = await loadTarget(ctx);
  requireAction(ctx, "remove_passkey", target);
  if (!(await removePasskey(target.id, ctx.params.pid))) throw err(404, "not_found", "That passkey was already removed.");
  await audited(ctx, "admin.remove_passkey", target, { passkey: ctx.params.pid.slice(0, 12) });
  return json({});
}

export async function resetTotp(ctx: ConsoleCtx) {
  need(ctx, "people.mfa");
  const target = await loadTarget(ctx);
  requireAction(ctx, "disable_totp", target);
  if (target.totpEnabledAt === null && target.totpPendingSecretEnc === null) throw err(409, "conflict", `${target.username} has no authenticator app connected.`);
  await disableTotp(target.id);
  await audited(ctx, "admin.disable_totp", target);
  return json({});
}

export async function revokePersonSessions(ctx: ConsoleCtx) {
  need(ctx, "sessions.revoke");
  const target = await loadTarget(ctx);
  requireAction(ctx, "sign_out_everywhere", target);
  const keep = target.id === ctx.me.id ? ctx.auth.session.idHash : null;
  const ended = await deleteSessions(target.id, keep);
  await audited(ctx, "admin.sign_out_everywhere", target, { sessions: ended });
  return json({ ended });
}

export async function revokeOneSession(ctx: ConsoleCtx, sid: string) {
  need(ctx, "sessions.revoke");
  const row = await first<{ id_hash: string; user_id: number }>("SELECT id_hash, user_id FROM sessions WHERE substr(id_hash, 1, 32) = ?", sid);
  if (!row) throw err(404, "not_found", "That session already ended.");
  const target = (await findUserById(row.user_id))!;
  requireAction(ctx, "revoke_session", target);
  await deleteSession(target.id, row.id_hash);
  await audited(ctx, "admin.revoke_session", target);
  return json({});
}

export async function setPersonStreak(ctx: ConsoleCtx) {
  const target = await loadTarget(ctx);
  // §4: the owner can set anyone's, including their own; admins need streaks.manage and not on themselves.
  if (!ctx.isOwner) need(ctx, "streaks.manage");
  requireAction(ctx, "set_streak", target);
  const n = Number(ctx.body.current);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SET_STREAK) {
    throw err(400, "validation", `Enter a whole number from 0 to ${MAX_SET_STREAK.toLocaleString("en-US")}.`, { field: "current" });
  }
  const result = (await adminSetStreak(ctx.me, target, n, ctx.now))!;
  await audited(ctx, "admin.set_streak", target, { from: result.from, to: n, self: ctx.me.id === target.id }, {
    kind: "set_streak",
    state: target.streak,
    event: target.streakLastEvent,
    after: { count: result.state.count, lastActivityAt: result.state.lastActivityAt },
  });
  return json({ streak: await streakView((await findUserById(target.id))!, ctx.now) });
}

export async function grantPersonRestores(ctx: ConsoleCtx) {
  const target = await loadTarget(ctx);
  if (!ctx.isOwner) need(ctx, "streaks.manage");
  requireAction(ctx, "grant_restores", target);
  const extra = Number(ctx.body.extra);
  if (!Number.isInteger(extra) || extra < 1 || extra > 31) throw err(400, "validation", "Grant from 1 to 31 extra restores.", { field: "extra" });
  const quota = await grantRestores(ctx.me, target, extra, ctx.now);
  await audited(ctx, "admin.grant_restores", target, { extra, month: quota.month });
  return json({ streak: await streakView(target, ctx.now) });
}

export async function emailPerson(ctx: ConsoleCtx) {
  need(ctx, "people.email");
  const target = await loadTarget(ctx);
  requireAction(ctx, "send_email", target);
  const subject = bodyStr(ctx, "subject").trim().slice(0, 200);
  const text = bodyStr(ctx, "body").trim().slice(0, 10_000);
  if (!subject) throw err(400, "validation", "Enter a subject.", { field: "subject" });
  if (!text) throw err(400, "validation", "Enter a message.", { field: "body" });
  const host = ctx.req.nextUrl.host;
  const delivery = await deliverEmail(
    { to: target.email, subject: `${subject} — ${APP_NAME}`, text, html: simpleHtml(text.split(/\n{2,}/)) },
    { local: isLocalHost(host) },
  );
  await audited(ctx, "admin.send_email", target, { subject, delivered: delivery.ok, provider: delivery.provider });
  if (!delivery.ok) throw err(502, "delivery_failed", `The email to ${target.email} wasn't sent: ${delivery.error}`);
  return json({ delivery: "sent" });
}

/** The create form (this site needs first/last name, username, email and mobile; the password is always generated). */
export async function peopleSchema(ctx: ConsoleCtx) {
  need(ctx, "people.view");
  const roles = ctx.isOwner
    ? [
        { value: "member", label: "Member" },
        { value: "admin", label: "Admin" },
      ]
    : [{ value: "member", label: "Member" }];
  return json({
    create_fields: [
      { key: "first_name", label: "First name", type: "text", maxlength: 60 },
      { key: "middle_name", label: "Middle name", type: "text", optional: true, maxlength: 60 },
      { key: "last_name", label: "Last name", type: "text", maxlength: 60 },
      { key: "username", label: "Username", type: "text", maxlength: 30 },
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Mobile (with country code)", type: "tel", placeholder: "+12125551234" },
      { key: "role", label: "Role", type: "select", value: "member", options: roles },
    ],
    profile_fields: null,
    note: "A temporary password is generated and shown to you once. They set up a passkey and an authenticator app at first sign-in, then choose their own password.",
  });
}
