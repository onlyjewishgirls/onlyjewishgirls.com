import "server-only";
import { eventLabel, type EventType } from "@/lib/admin/events";
import { isAdminRole } from "@/lib/admin/permissions";
import { securityAlert, type AlertEvent } from "./alerts";
import { first } from "./db";
import type { RequestInfo } from "./events";

interface Subject {
  id: number;
  username: string;
}

interface Logged {
  user?: Subject | null;
  actor?: Subject | null;
  detail?: Record<string, unknown>;
  now: number;
  id: number | null;
  info: RequestInfo;
  ip?: string | null;
}

/** Audit event → alert event. Anything not listed is audited only. */
const ALERTS: Partial<Record<EventType, AlertEvent>> = {
  "signin.failed": "failed_signin",
  "signin.unknown": "failed_signin",
  "signin.mfa_failed": "failed_mfa",
  "signin.rate_limited": "account_lockout",
  "signin.mfa_locked": "account_lockout",
  "mfa.passkey_added": "mfa_changed",
  "mfa.totp_enabled": "mfa_changed",
  "mfa.recovery_codes": "mfa_changed",
  "admin.remove_passkey": "mfa_changed",
  "admin.disable_totp": "mfa_changed",
  "admin.toggle_email_otp": "mfa_changed",
  "admin.clear_recovery_codes": "mfa_changed",
  "admin.reset_two_step": "mfa_changed",
  "password.reset": "password_changed",
  "password.changed": "password_changed",
  "admin.set_temp_password": "password_changed",
  "admin.send_password_reset": "password_changed",
  "admin.force_change": "password_changed",
  "admin.set_role": "role_changed",
  "admin.set_permissions": "role_changed",
  "account.created": "user_created",
  "admin.create_account": "user_created",
  "admin.suspend": "user_status",
  "admin.unsuspend": "user_status",
  "admin.lock": "user_status",
  "admin.unlock": "user_status",
  "admin.delete": "user_status",
  "admin.ip_allow_add": "ip_list_changed",
  "admin.ip_allow_update": "ip_list_changed",
  "admin.ip_allow_remove": "ip_list_changed",
  "admin.ip_deny_add": "ip_list_changed",
  "admin.ip_deny_update": "ip_list_changed",
  "admin.ip_unblock": "ip_list_changed",
  "security.decoy": "decoy_hit",
  "security.admin_denied": "admin_access_denied",
  "admin.set_streak": "streak_set",
  "admin.settings": "settings_changed",
  // security.auto_blocked and security.hostile send their own, richer alerts (threat.ts).
};

/** Failed sign-ins dedupe per account + IP; everything else per account (or IP when there's none). */
function dedupeKey(type: EventType, e: Logged, ip: string | null): string {
  const who = e.user ? `u${e.user.id}` : typeof e.detail?.identifier === "string" ? `name:${e.detail.identifier}` : "-";
  if (type === "signin.failed" || type === "signin.unknown" || type === "signin.mfa_failed") return `${who}:${ip ?? "-"}`;
  if (type.startsWith("admin.ip_") || type.startsWith("security.")) return ip ?? who;
  return who;
}

function describe(type: EventType, e: Logged): string {
  const label = eventLabel(type);
  const target = e.user?.username;
  const actor = e.actor && e.actor.id !== e.user?.id ? e.actor.username : null;
  const extra = e.detail
    ? Object.entries(e.detail)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ")
    : "";
  return `${label}${target ? ` — account ${target}` : ""}${actor ? `, by ${actor}` : ""}${extra ? ` (${extra})` : ""}.`;
}

export async function alertForEvent(type: EventType, e: Logged) {
  const ip = e.ip !== undefined ? e.ip : e.info.ip;
  const base = {
    user: e.user ?? null,
    actor: e.actor ?? null,
    ip,
    country: e.info.country,
    userAgent: e.info.userAgent,
    auditId: e.id,
    now: e.now,
  };
  if (type === "signin.complete" && e.user) {
    await signInAlerts(e.user, base);
    return;
  }
  const event = ALERTS[type];
  if (!event) return;
  await securityAlert({ ...base, event, title: eventLabel(type), key: dedupeKey(type, e, ip), what: describe(type, e) });
}

/** New device / IP / country, and every successful admin sign-in. */
async function signInAlerts(user: Subject, base: Omit<Parameters<typeof securityAlert>[0], "event" | "title" | "key" | "what">) {
  const row = await first<{ role: string; prior: number; same_ip: number; same_country: number; same_ua: number }>(
    `SELECT u.role,
       (SELECT COUNT(*) FROM events WHERE user_id = u.id AND type = 'signin.complete' AND id != ?2) AS prior,
       (SELECT COUNT(*) FROM events WHERE user_id = u.id AND type = 'signin.complete' AND id != ?2 AND ip IS ?3) AS same_ip,
       (SELECT COUNT(*) FROM events WHERE user_id = u.id AND type = 'signin.complete' AND id != ?2 AND country IS ?4) AS same_country,
       (SELECT COUNT(*) FROM events WHERE user_id = u.id AND type = 'signin.complete' AND id != ?2 AND user_agent IS ?5) AS same_ua
     FROM users u WHERE u.id = ?1`,
    user.id,
    base.auditId ?? -1,
    base.ip ?? null,
    base.country ?? null,
    base.userAgent ?? null,
  );
  if (!row) return;
  if (row.prior > 0) {
    const what: string[] = [];
    if (row.same_ip === 0) what.push("IP address");
    if (row.same_country === 0 && base.country) what.push("country");
    if (row.same_ua === 0) what.push("device/browser");
    if (what.length) {
      await securityAlert({
        ...base,
        event: "new_device",
        title: "Sign-in from a new device, IP or country",
        key: `u${user.id}:${base.ip ?? "-"}:${base.country ?? "-"}`,
        what: `${user.username} signed in from a new ${what.join(", ")}.`,
      });
    }
  }
  if (row.role && isAdminRole(row.role as "admin" | "owner")) {
    await securityAlert({
      ...base,
      event: "admin_signin",
      title: `Successful ${row.role} sign-in`,
      key: `u${user.id}:${base.ip ?? "-"}`,
      what: `${user.username} (${row.role}) signed in.`,
    });
  }
}
