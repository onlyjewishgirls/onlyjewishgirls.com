import "server-only";
import { alertRouting, type AlertRouting } from "@/lib/security";
import { recordAndSendWith, type AlertInput } from "./alert-core";
import { all, run } from "./db";
import { APP_NAME, cfEnv, inBackground, isLocalHost, requestHost } from "./env";
import { getSettings } from "./settings";

// Composing, deduping, recording and sending live in alert-core.ts (no Next.js imports, so the
// Worker entry's CAPTCHA-wall alert goes through the same path).
export { ALERT_DEDUPE_MS, composeAlert, type AlertEvent, type AlertInput, type ComposedAlert } from "./alert-core";

export function currentRouting(host: string): AlertRouting {
  return alertRouting(cfEnv(), host);
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

/** One email per (event, key) per 10 minutes (see recordAndSendWith). Returns the alert row's id. */
export async function recordAndSend(input: AlertInput, host: string): Promise<number | null> {
  const { time_zone: timeZone } = await getSettings();
  return recordAndSendWith({ env: cfEnv(), db: { all, run }, site: APP_NAME, timeZone, local: isLocalHost(host) }, input, host);
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
