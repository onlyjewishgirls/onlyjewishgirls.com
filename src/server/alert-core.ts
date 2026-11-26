/**
 * Security alert emails (PORTAL-STANDARD §6): compose, dedupe, record in `security_alerts` and send.
 * The database and the Worker's variables are passed in, and nothing here imports Next.js or OpenNext,
 * so the Worker entry (src/worker/captcha.ts: the CAPTCHA wall's once-a-day "wall is off" alert) sends
 * through exactly the same path as the app. The app uses it through alerts.ts.
 *
 * Every alert reads as a calm notice from the business (mail-template.ts): who it is from and why the
 * recipient gets it, what happened, when (portal zone and UTC), the IP address and approximate
 * location, the account and portal, and what to do. Alerts only ever go to ALERTS_EMAIL_TO.
 */
import { describeDevice } from "../lib/admin/format";
import { alertRouting, type AlertEnv } from "../lib/security";
import { deliverEmailWith, type MailEnv } from "./mail-core";
import { approximateLocation, formatWhen, mailIdentity, renderNotice, subjectLine, type MailIdentity } from "./mail-template";

/** One email per (event, key) per this long; later ones are recorded as throttled and counted in the next. */
export const ALERT_DEDUPE_MS = 10 * 60_000;

/**
 * Alerts about anonymous internet traffic (scanners, decoy hits, auto-blacklist, hostile visitors,
 * admin-endpoint denials). They are digested: at most one email per event type per DIGEST_MS, and the
 * addresses recorded in between are listed in the next one. Every event is still a security_alerts row.
 */
export const DIGEST_EVENTS: ReadonlySet<AlertEvent> = new Set<AlertEvent>(["auto_blacklist", "hostile_visitor", "decoy_hit", "admin_access_denied"]);
export const DIGEST_MS = 60 * 60_000;
/** Addresses listed by name in a digest; the rest are "and N more". */
export const DIGEST_LIST_MAX = 20;

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
  /** Short name of the specific event, e.g. "Wrong password" (shown as "Event" in the details). */
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
  city?: string | null;
  region?: string | null;
  userAgent?: string | null;
  auditId?: number | null;
  /** §7: the blocked IP belongs to the owner's live session. Shown prominently, and never held back. */
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
  /** Portal time zone (the time_zone setting) for the times in the body. */
  timeZone: string;
  /** Local development: http links, and an unconfigured mailer prints instead of failing. */
  local: boolean;
}

/** The plain-words subject for each event, and what the administrator can do about it. */
const COPY: Record<AlertEvent, { subject: string; actions: string[] }> = {
  failed_signin: {
    subject: "Failed sign-in attempt",
    actions: [
      "If you recognise the account and the address (for example a member who mistyped a password), no action is needed.",
      "Repeated failures from one address are blocked automatically; blocked addresses are on the console's Deny list.",
    ],
  },
  failed_mfa: {
    subject: "Failed two-step verification",
    actions: [
      "The password was right but the second step was not. If this keeps happening for one account, contact the member, and consider resetting their two-step sign-in from People in the console.",
    ],
  },
  account_lockout: {
    subject: "Sign-in paused after repeated attempts",
    actions: [
      "Sign-in for this account or address is paused for a while and reopens by itself.",
      "If a member was paused by mistake, use Unlock sign-in on their page in the console.",
    ],
  },
  new_device: {
    subject: "Sign-in from a new device or location",
    actions: [
      "If you know the member got a new device or is travelling, no action is needed.",
      "If it looks wrong, sign the account out everywhere from People in the console and contact the member.",
    ],
  },
  admin_signin: {
    subject: "Administrator signed in",
    actions: [
      "If this was you or another administrator, no action is needed.",
      "If you don't recognise it, sign that account out everywhere from People in the console and reset its two-step sign-in.",
    ],
  },
  mfa_changed: {
    subject: "Two-step sign-in settings changed",
    actions: ["If you or the member expected this change, no action is needed.", "If not, check the account's two-step sign-in methods on its page in the console."],
  },
  password_changed: {
    subject: "Account password changed",
    actions: ["If you or the member expected this change, no action is needed.", "If not, sign the account out everywhere from People in the console and contact the member."],
  },
  role_changed: {
    subject: "Account role or permissions changed",
    actions: ["If this change was planned, no action is needed.", "If not, check the account's role on Roles & permissions in the console."],
  },
  user_created: {
    subject: "New account created",
    actions: ["No action is needed for an expected sign-up or an account an administrator made.", "The account is listed under People in the console."],
  },
  user_status: {
    subject: "Account status changed",
    actions: ["If this change was planned, no action is needed.", "The change can be undone from the account's page in the console."],
  },
  ip_list_changed: {
    subject: "IP allowlist or deny list changed",
    actions: ["If this change was planned, no action is needed.", "The current entries are on the console's IP allowlist and Deny list pages."],
  },
  auto_blacklist: {
    subject: "IP address blocked automatically",
    actions: [
      "No action is needed: the address is already blocked.",
      "If an address was blocked by mistake, unblock it from the console's Deny list, where each entry shows its evidence.",
    ],
  },
  hostile_visitor: {
    subject: "Visitor reached the hostile threat level",
    actions: ["No action is needed: the site keeps watching the address and blocks it automatically when a threshold is crossed."],
  },
  decoy_hit: {
    subject: "Request to a scanner decoy path",
    actions: ["No action is needed: these are automated scanners looking for files this site doesn't have. The address is blocked automatically."],
  },
  admin_access_denied: {
    subject: "Admin area request refused",
    actions: ["No action is needed: the request was refused. Repeated attempts from one address are blocked automatically."],
  },
  country_blocked: {
    subject: "Sign-in refused by the country rule",
    actions: ["If a member is travelling, you can adjust the country rule in the console."],
  },
  streak_set: {
    subject: "Streak changed by an administrator",
    actions: ["If this change was planned, no action is needed.", "The change is in the console's Audit log."],
  },
  settings_changed: {
    subject: "Portal settings changed",
    actions: ["If this change was planned, no action is needed.", "The current values are on the console's Settings page."],
  },
  captcha_off: {
    subject: "CAPTCHA wall turned off",
    actions: ["If you turned it off on purpose, no action is needed; this notice repeats once a day while it stays off.", "To turn it back on, delete the GATE_MODE variable on the Worker."],
  },
  test: {
    subject: "Test alert",
    actions: ["No action is needed: this checks that security alerts reach you."],
  },
};

function alertSubject(input: AlertInput, id: MailIdentity, suffix = ""): string {
  return subjectLine(id, input.ownerLockout ? "The owner's IP address was blocked automatically" : COPY[input.event].subject, suffix);
}

export interface Digest {
  /** "203.0.113.5 (3 events)", busiest first, at most DIGEST_LIST_MAX, then "and N more addresses". */
  items: string[];
  /** Events in this email, this one included. */
  events: number;
  addresses: number;
  /** When the previous email about this event type went out, if any. */
  since: number | null;
}

/** Pure (exported for tests): the subject, the HTML Plunk gets and the matching text. */
export function composeAlert(
  input: AlertInput,
  ctx: { identity: MailIdentity; timeZone: string; auditUrl: string | null; suppressed: number; now: number; host?: string; digest?: Digest | null },
): ComposedAlert {
  const id = ctx.identity;
  const digest = ctx.digest && ctx.digest.events > 1 ? ctx.digest : null;
  const more = digest ? digest.events - 1 : ctx.suppressed;
  const subject = alertSubject(input, id, more > 0 ? ` (and ${more} more like it)` : "");

  const paragraphs = [input.what];
  if (digest) {
    paragraphs.push(
      `To keep these notices to one an hour, this email covers ${digest.events} events of this kind from ${digest.addresses} address${digest.addresses === 1 ? "" : "es"}${
        digest.since ? `, recorded since the last one at ${formatWhen(digest.since, ctx.timeZone)}` : ""
      }. Each one is in the console's Security alerts list.`,
    );
  } else if (ctx.suppressed > 0) {
    paragraphs.push(
      `There ${ctx.suppressed === 1 ? "was" : "were"} also ${ctx.suppressed} more alert${ctx.suppressed === 1 ? "" : "s"} like this in the last ${ALERT_DEDUPE_MS / 60_000} minutes. They are recorded in the console but were not emailed one by one.`,
    );
  }

  const details: [string, string][] = [["Event", input.title]];
  details.push(["Portal", `${id.name} ${id.portal} (${ctx.host ?? id.host})`]);
  details.push(["Account", input.user ? input.user.username : "None (no account involved)"]);
  if (input.actor && input.actor.id !== input.user?.id) details.push(["Done by", input.actor.username]);
  details.push(["When", formatWhen(ctx.now, ctx.timeZone)]);
  details.push(["IP address", input.ip ?? "Not known"]);
  details.push(["Approximate location", approximateLocation(input) ?? "Not known"]);
  if (input.userAgent) {
    details.push(["Device", describeDevice(input.userAgent)]);
    details.push(["Browser (user agent)", input.userAgent]);
  }
  for (const d of input.details ?? []) details.push(d);

  const actions = input.ownerLockout
    ? [
        "If the owner was blocked by mistake, unblock the address from the console's Deny list using another network (for example mobile data), or with the command above.",
        "If the owner's address really did this, leave the block in place and check the owner account's sessions and two-step sign-in.",
      ]
    : [...COPY[input.event].actions];
  if (ctx.auditUrl) actions.push(`Review it in the console: ${ctx.auditUrl}`);
  actions.push(`If something here doesn't look right and you need help, reply to this email or write to ${id.supportEmail}.`);

  const callout = input.ownerLockout
    ? `This IP address (${input.ip ?? "unknown"}) belongs to the owner's live session, so the owner has been signed out and blocked from it. To unblock it, open the console's Deny list from another network, or run: npx wrangler d1 execute onlyjewishgirls --remote --command "UPDATE ip_rules SET revoked_at = unixepoch() * 1000 WHERE kind = 'deny' AND ip = '${input.ip ?? "<ip>"}'"`
    : undefined;

  const { html, text } = renderNotice(id, {
    heading: input.ownerLockout ? "The owner's IP address was blocked automatically" : COPY[input.event].subject,
    audience: { kind: "admin" },
    callout,
    paragraphs,
    details,
    list: digest ? { heading: "Addresses (busiest first)", items: digest.items } : undefined,
    actions,
  });
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
 * the rest are recorded as throttled and counted as "and N more" in the next email.
 *
 * Anonymous-traffic events (DIGEST_EVENTS) use the same statement keyed by the event type alone, with a
 * one-hour window: one email per event type per hour, listing every address recorded since the last.
 * An owner-lockout auto-blacklist is never held back. Sign-in codes don't come through here at all.
 */
export async function recordAndSendWith(c: AlertContext, input: AlertInput, host: string): Promise<number | null> {
  const now = input.now ?? Date.now();
  const identity = mailIdentity(c.env);
  const routing = alertRouting(c.env, host);
  const origin = siteOrigin(c, host);
  const auditUrl = input.auditId ? `${origin}/admin#audit/${input.auditId}` : `${origin}/admin#alerts`;
  const digested = DIGEST_EVENTS.has(input.event);
  const force = input.event === "test" || input.ownerLockout ? 1 : 0;
  const [row] = await c.db.all<{ id: number; status: string; suppressed: number }>(
    `INSERT INTO security_alerts (at, event, dedupe_key, subject, to_addr, from_addr, status, suppressed, ip, user_id,
                                  username, audit_id, owner_lockout)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, d.status,
       CASE d.status WHEN 'throttled' THEN 0 ELSE (
         SELECT COUNT(*) FROM security_alerts WHERE event = ?2 AND (?14 = 1 OR dedupe_key = ?3) AND status = 'throttled'
           AND at > COALESCE((SELECT MAX(at) FROM security_alerts WHERE event = ?2 AND (?14 = 1 OR dedupe_key = ?3) AND status != 'throttled'), 0)
       ) END,
       ?7, ?8, ?9, ?10, ?11
     FROM (SELECT CASE WHEN ?12 = 0 AND EXISTS (
             SELECT 1 FROM security_alerts WHERE event = ?2 AND (?14 = 1 OR dedupe_key = ?3) AND status != 'throttled' AND at > ?1 - ?13
           ) THEN 'throttled' ELSE 'queued' END AS status) d
     RETURNING id, status, suppressed`,
    now,
    input.event,
    input.key,
    alertSubject(input, identity),
    routing.to,
    routing.from,
    input.ip ?? null,
    input.user?.id ?? null,
    input.user?.username ?? null,
    input.auditId ?? null,
    input.ownerLockout ? 1 : 0,
    force,
    digested ? DIGEST_MS : ALERT_DEDUPE_MS,
    digested ? 1 : 0,
  );
  if (!row) return null;
  if (row.status === "throttled") return row.id;
  const digest = digested ? await collectDigest(c, input, row.id) : null;
  const mail = composeAlert(input, { identity, timeZone: c.timeZone, auditUrl, suppressed: row.suppressed, now, host: host.replace(/:\d+$/, "") || undefined, digest });
  const delivery = await deliverEmailWith(
    c.env,
    { to: routing.to, subject: mail.subject, text: mail.text, html: mail.html },
    { local: c.local, fromEmail: routing.from },
  );
  await c.db.run(
    "UPDATE security_alerts SET status = ?, provider = ?, error = ?, subject = ? WHERE id = ?",
    delivery.ok ? "sent" : "failed",
    delivery.provider,
    delivery.error,
    mail.subject,
    row.id,
  );
  // Keep a year of alerts.
  await c.db.run("DELETE FROM security_alerts WHERE at < ?", now - 365 * 86_400_000);
  return row.id;
}

/** The addresses behind the throttled events since the last email of this type, plus this one. */
async function collectDigest(c: AlertContext, input: AlertInput, rowId: number): Promise<Digest> {
  const [prev] = await c.db.all<{ at: number | null }>(
    "SELECT MAX(at) AS at FROM security_alerts WHERE event = ? AND status != 'throttled' AND id < ?",
    input.event,
    rowId,
  );
  const since = prev?.at ?? null;
  const rows = await c.db.all<{ addr: string; n: number }>(
    `SELECT COALESCE(ip, dedupe_key) AS addr, COUNT(*) AS n FROM security_alerts
     WHERE event = ? AND status = 'throttled' AND id < ? AND at > ?
     GROUP BY addr`,
    input.event,
    rowId,
    since ?? 0,
  );
  const counts = new Map(rows.map((r) => [r.addr, Number(r.n)]));
  const self = input.ip ?? input.key;
  counts.set(self, (counts.get(self) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }));
  const items = sorted.slice(0, DIGEST_LIST_MAX).map(([addr, n]) => `${addr} (${n} event${n === 1 ? "" : "s"})`);
  if (sorted.length > DIGEST_LIST_MAX) {
    const rest = sorted.length - DIGEST_LIST_MAX;
    items.push(`and ${rest} more address${rest === 1 ? "" : "es"}`);
  }
  return { items, events: sorted.reduce((sum, [, n]) => sum + n, 0), addresses: sorted.length, since };
}
