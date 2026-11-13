/**
 * Security alert emails (PORTAL-STANDARD §6): compose, dedupe, record in `security_alerts` and send.
 * The database and the Worker's variables are passed in, and nothing here imports Next.js or OpenNext,
 * so the Worker entry (src/worker/captcha.ts: the CAPTCHA wall's once-a-day "wall is off" alert) sends
 * through exactly the same path as the app. The app uses it through alerts.ts.
 */
import { describeDevice } from "../lib/admin/format";
import { alertRouting, type AlertEnv } from "../lib/security";
import { deliverEmailWith, escapeHtml, type MailEnv } from "./mail-core";

/** One email per (event, key) per this long; later ones are recorded as throttled and counted in the next. */
export const ALERT_DEDUPE_MS = 10 * 60_000;

export type AlertEvent =
  | "failed_signin"
  | "failed_mfa"
  | "account_lockout"
  | "new_device"
  | "admin_signin"
  | "mfa_changed"
  | "password_changed"
  | "role_changed"
  | "user_created"
  | "user_status"
  | "ip_list_changed"
  | "auto_blacklist"
  | "hostile_visitor"
  | "decoy_hit"
  | "admin_access_denied"
  | "country_blocked"
  | "streak_set"
  | "settings_changed"
  | "captcha_off"
  | "test";

export interface AlertInput {
  event: AlertEvent;
  /** Short title for the subject, e.g. "Failed sign-in". */
  title: string;
  /** Dedupe key within the event type, e.g. "<account>:<ip>". */
  key: string;
  /** What happened, one sentence. */
  what: string;
  /** Extra "Label: value" lines. */
  details?: [string, string][];
  user?: { id: number; username: string } | null;
  actor?: { id: number; username: string } | null;
  ip?: string | null;
  country?: string | null;
  userAgent?: string | null;
  auditId?: number | null;
  /** §7: the blocked IP belongs to the owner's live session. Shown prominently. */
  ownerLockout?: boolean;
  now?: number;
}

export interface ComposedAlert {
  subject: string;
  text: string;
  html: string;
}

type Param = string | number | null;

/** The two database calls the alert path makes (db.ts in the app; a D1 adapter in the Worker entry). */
export interface AlertStore {
  all<T>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number; lastRowId: number }>;
}

export interface AlertContext {
  env: AlertEnv & MailEnv & { PUBLIC_ORIGIN?: string };
  db: AlertStore;
  /** Site name for the subject, e.g. "OnlyJewishGirls". */
  site: string;
  /** Portal time zone (the time_zone setting) for the times in the body. */
  timeZone: string;
  /** Local development: http links, and an unconfigured mailer prints instead of failing. */
  local: boolean;
}

function formatIn(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "long",
  });
}

function alertSubject(input: AlertInput, site: string): string {
  return `[SECURITY] ${site} — ${input.ownerLockout ? "OWNER LOCKOUT: " : ""}${input.title}`;
}

/** Subject `[SECURITY] <site> — <event>`, plain text plus simple HTML. Pure (exported for tests). */
export function composeAlert(
  input: AlertInput,
  ctx: { site: string; timeZone: string; auditUrl: string | null; suppressed: number; now: number },
): ComposedAlert {
  const subject = alertSubject(input, ctx.site);
  const rows: [string, string][] = [];
  if (input.ownerLockout) {
    rows.push([
      "WARNING",
      "This IP address belongs to the OWNER's live session. The owner has been signed out and blocked from this address. Unblock it from the console's Deny list on another network, or with: npx wrangler d1 execute onlyjewishgirls --remote --command \"UPDATE ip_rules SET revoked_at = unixepoch() * 1000 WHERE kind = 'deny' AND ip = '<ip>'\"",
    ]);
  }
  rows.push(["What", input.what]);
  if (input.user) rows.push(["Account", input.user.username]);
  if (input.actor && input.actor.id !== input.user?.id) rows.push(["By", input.actor.username]);
  rows.push(["IP", input.ip ?? "unknown"]);
  rows.push(["Country", input.country ?? "unknown"]);
  rows.push(["User agent", input.userAgent ?? "unknown"]);
  rows.push(["Device", input.userAgent ? describeDevice(input.userAgent) : "unknown"]);
  rows.push(["Time", `${formatIn(ctx.now, ctx.timeZone)} (${ctx.timeZone}) · ${new Date(ctx.now).toISOString()} UTC`]);
  for (const d of input.details ?? []) rows.push(d);
  if (ctx.suppressed > 0) {
    rows.push(["Also", `+${ctx.suppressed} more alert${ctx.suppressed === 1 ? "" : "s"} like this in the last ${ALERT_DEDUPE_MS / 60_000} minutes (throttled)`]);
  }
  if (ctx.auditUrl) rows.push(["Audit entry", ctx.auditUrl]);

  const text = `${subject}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
  const banner = input.ownerLockout
    ? `<p style="margin:0 0 16px;padding:12px;border:2px solid #b42318;background:#fef3f2;color:#b42318;font-weight:700">OWNER LOCKOUT — this IP belonged to the owner's live session.</p>`
    : "";
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1c1b22;max-width:640px">
<h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(subject)}</h2>${banner}
<table style="border-collapse:collapse">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#5b5a66;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:4px 0">${
          k === "Audit entry" ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v)
        }</td></tr>`,
    )
    .join("")}</table></div>`;
  return { subject, text, html };
}

function siteOrigin(c: AlertContext, host: string): string {
  const configured = c.env.PUBLIC_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  return `${c.local ? "http" : "https"}://${host}`;
}

/**
 * Records the alert and, unless it is throttled, emails it. The throttle decision and the row are one
 * statement, so concurrent alerts with the same (event, key), say a burst of parallel requests from one
 * noisy address, can't both see "nothing sent yet" and both send: exactly one is queued per 10 minutes,
 * the rest are recorded as throttled and counted as "+N more" in the next email.
 */
export async function recordAndSendWith(c: AlertContext, input: AlertInput, host: string): Promise<number | null> {
  const now = input.now ?? Date.now();
  const routing = alertRouting(c.env, host);
  const origin = siteOrigin(c, host);
  const auditUrl = input.auditId ? `${origin}/admin#audit/${input.auditId}` : `${origin}/admin#alerts`;
  const [row] = await c.db.all<{ id: number; status: string; suppressed: number }>(
    `INSERT INTO security_alerts (at, event, dedupe_key, subject, to_addr, from_addr, status, suppressed, ip, user_id,
                                  username, audit_id, owner_lockout)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, d.status,
       CASE d.status WHEN 'throttled' THEN 0 ELSE (
         SELECT COUNT(*) FROM security_alerts WHERE event = ?2 AND dedupe_key = ?3 AND status = 'throttled'
           AND at > COALESCE((SELECT MAX(at) FROM security_alerts WHERE event = ?2 AND dedupe_key = ?3 AND status != 'throttled'), 0)
       ) END,
       ?7, ?8, ?9, ?10, ?11
     FROM (SELECT CASE WHEN ?12 = 0 AND EXISTS (
             SELECT 1 FROM security_alerts WHERE event = ?2 AND dedupe_key = ?3 AND status != 'throttled' AND at > ?1 - ?13
           ) THEN 'throttled' ELSE 'queued' END AS status) d
     RETURNING id, status, suppressed`,
    now,
    input.event,
    input.key,
    alertSubject(input, c.site),
    routing.to,
    routing.from,
    input.ip ?? null,
    input.user?.id ?? null,
    input.user?.username ?? null,
    input.auditId ?? null,
    input.ownerLockout ? 1 : 0,
    input.event === "test" ? 1 : 0,
    ALERT_DEDUPE_MS,
  );
  if (!row) return null;
  if (row.status === "throttled") return row.id;
  const mail = composeAlert(input, { site: c.site, timeZone: c.timeZone, auditUrl, suppressed: row.suppressed, now });
  const delivery = await deliverEmailWith(
    c.env,
    { to: routing.to, subject: mail.subject, text: mail.text, html: mail.html },
    { local: c.local, from: `${c.site} Security <${routing.from}>` },
  );
  await c.db.run(
    "UPDATE security_alerts SET status = ?, provider = ?, error = ? WHERE id = ?",
    delivery.ok ? "sent" : "failed",
    delivery.provider,
    delivery.error,
    row.id,
  );
  // Keep a year of alerts.
  await c.db.run("DELETE FROM security_alerts WHERE at < ?", now - 365 * 86_400_000);
  return row.id;
}
