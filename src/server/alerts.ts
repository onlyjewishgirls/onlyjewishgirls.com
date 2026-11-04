import "server-only";
import { describeDevice } from "@/lib/admin/format";
import { alertRouting, type AlertRouting } from "@/lib/security";
import { all, first, run } from "./db";
import { APP_NAME, cfEnv, inBackground, isLocalHost, requestHost } from "./env";
import { deliverEmail, escapeHtml } from "./mailer";
import { getSettings } from "./settings";

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
  | "streak_set"
  | "settings_changed"
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

export function currentRouting(host: string): AlertRouting {
  return alertRouting(cfEnv(), host);
}

function siteOrigin(host: string): string {
  const configured = cfEnv().PUBLIC_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  return `${isLocalHost(host) ? "http" : "https"}://${host}`;
}

function formatIn(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "long",
  });
}

export interface ComposedAlert {
  subject: string;
  text: string;
  html: string;
}

/** Subject `[SECURITY] <site> — <event>`, plain text plus simple HTML. Pure (exported for tests). */
export function composeAlert(
  input: AlertInput,
  ctx: { site: string; timeZone: string; auditUrl: string | null; suppressed: number; now: number },
): ComposedAlert {
  const subject = `[SECURITY] ${ctx.site} — ${input.ownerLockout ? "OWNER LOCKOUT: " : ""}${input.title}`;
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

/**
 * Records and (unless throttled) emails a security alert. Returns at once: the
 * dedupe check, the row and the email all run in the background, so an alert
 * never slows or breaks the request that caused it.
 */
export async function securityAlert(input: AlertInput): Promise<void> {
  let host = "";
  try {
    host = await requestHost();
  } catch {
    host = "";
  }
  if (!host) host = new URL(cfEnv().PUBLIC_ORIGIN ?? "https://onlyjewishgirls.com").host;
  inBackground(recordAndSend(input, host));
}

export async function recordAndSend(input: AlertInput, host: string): Promise<number | null> {
  const now = input.now ?? Date.now();
  const routing = currentRouting(host);
  const { time_zone: timeZone } = await getSettings();
  const previous = await first<{ id: number; at: number }>(
    `SELECT id, at FROM security_alerts WHERE event = ? AND dedupe_key = ? AND status != 'throttled'
     ORDER BY at DESC LIMIT 1`,
    input.event,
    input.key,
  );
  const origin = siteOrigin(host);
  const auditUrl = input.auditId ? `${origin}/admin#audit/${input.auditId}` : `${origin}/admin#alerts`;
  const throttled = previous !== null && now - previous.at < ALERT_DEDUPE_MS && input.event !== "test";
  const suppressedRow = throttled
    ? null
    : await first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM security_alerts WHERE event = ? AND dedupe_key = ? AND status = 'throttled' AND at > ?",
        input.event,
        input.key,
        previous?.at ?? 0,
      );
  const suppressed = suppressedRow?.n ?? 0;
  const mail = composeAlert(input, { site: APP_NAME, timeZone, auditUrl, suppressed, now });
  const { lastRowId } = await run(
    `INSERT INTO security_alerts (at, event, dedupe_key, subject, to_addr, from_addr, status, suppressed, ip, user_id,
                                  username, audit_id, owner_lockout)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    now,
    input.event,
    input.key,
    mail.subject,
    routing.to,
    routing.from,
    throttled ? "throttled" : "queued",
    suppressed,
    input.ip ?? null,
    input.user?.id ?? null,
    input.user?.username ?? null,
    input.auditId ?? null,
    input.ownerLockout ? 1 : 0,
  );
  if (throttled) return lastRowId;
  const delivery = await deliverEmail(
    { to: routing.to, subject: mail.subject, text: mail.text, html: mail.html },
    { local: isLocalHost(host), from: `${APP_NAME} Security <${routing.from}>` },
  );
  await run(
    "UPDATE security_alerts SET status = ?, provider = ?, error = ? WHERE id = ?",
    delivery.ok ? "sent" : "failed",
    delivery.provider,
    delivery.error,
    lastRowId,
  );
  // Keep a year of alerts.
  await run("DELETE FROM security_alerts WHERE at < ?", now - 365 * 86_400_000);
  return lastRowId;
}

export interface AlertRow {
  id: number;
  at: number;
  event: string;
  dedupe_key: string;
  subject: string;
  to_addr: string;
  from_addr: string;
  status: string;
  provider: string | null;
  error: string | null;
  suppressed: number;
  ip: string | null;
  user_id: number | null;
  username: string | null;
  audit_id: number | null;
  owner_lockout: number;
}

export async function listAlerts(options: { status?: string; event?: string; q?: string; before?: number; limit: number }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  if (options.event) {
    where.push("event = ?");
    params.push(options.event);
  }
  if (options.q) {
    where.push("(subject LIKE ? OR ip LIKE ? OR username LIKE ?)");
    const like = `%${options.q.replace(/[%_]/g, "")}%`;
    params.push(like, like, like);
  }
  if (options.before) {
    where.push("id < ?");
    params.push(options.before);
  }
  const rows = await all<AlertRow>(
    `SELECT * FROM security_alerts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    options.limit + 1,
  );
  return { rows: rows.slice(0, options.limit), more: rows.length > options.limit };
}
