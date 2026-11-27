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
  /** §7: the blocked IP belongs to the owner's live session. Shown prominently, and always emailed. */
  ownerLockout?: boolean;
  /** Auto-blacklist only: the address was on the allowlist (taken off it by the block). Always emailed. */
  wasAllowlisted?: boolean;
  /**
   * Auto-blacklist only: the latest successful sign-in from the address in the last 24 hours, if any.
   * A real person flagged right after signing in is emailed; an address that never signed in is not.
   */
  signedIn?: { username: string; at: number } | null;
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

/**
 * Whether an alert is emailed (PORTAL-STANDARD §6 "Volume", owner 2026-11-26: "if an address gets
 * autoblocked dont send an email only send an email for super important security alerts or if an
 * address that got blocked was from someone who signed in successfully but got flagged right after").
 *
 * Anonymous internet traffic is recorded (security_alerts status `suppressed`, the audit log, the deny
 * list) and shown in the console, but not emailed: scanner/decoy hits, hostile visitors, country-rule
 * refusals, failed sign-ins for accounts that don't exist, refused admin requests (with or without an
 * account: a member opening /admin is normal use), and
 * auto-blocks of an address with no successful sign-in in the last 24 hours that wasn't allowlisted or
 * the owner's. Everything else is emailed, with the usual 10-minute dedupe. Pure; exported for tests.
 */
export function shouldEmail(input: AlertInput): boolean {
  switch (input.event) {
    case "decoy_hit":
    case "hostile_visitor":
    case "country_blocked":
    // A refused admin request isn't on the standard's email list: with no account it is anonymous
    // traffic, and a signed-in member opening /admin from a bookmark is normal use (owner, 2026-11-26).
    // Both are recorded; an address that is then auto-blocked after signing in is emailed.
    case "admin_access_denied":
      return false;
    case "failed_signin":
      return Boolean(input.user);
    case "auto_blacklist":
      return Boolean(input.ownerLockout || input.wasAllowlisted || input.signedIn);
    default:
      return true;
  }
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

/** The heading and subject wording: the plain-words event, or which kind of auto-block it was. */
function headline(input: AlertInput): string {
  if (input.event === "auto_blacklist") {
    if (input.ownerLockout) return "The owner's IP address was blocked automatically";
    if (input.wasAllowlisted) return "An allowlisted IP address was blocked automatically";
    if (input.signedIn) return `IP address blocked automatically after ${input.signedIn.username} signed in from it`;
  }
  return COPY[input.event].subject;
}

function alertSubject(input: AlertInput, id: MailIdentity, suffix = ""): string {
  return subjectLine(id, headline(input), suffix);
}

/** Pure (exported for tests): the subject, the HTML Plunk gets and the matching text. */
export function composeAlert(
  input: AlertInput,
  ctx: { identity: MailIdentity; timeZone: string; auditUrl: string | null; suppressed: number; now: number; host?: string; consoleUrl?: string },
): ComposedAlert {
  const id = ctx.identity;
  const subject = alertSubject(input, id, ctx.suppressed > 0 ? ` (and ${ctx.suppressed} more like it)` : "");

  const paragraphs = [input.what];
  if (input.event === "auto_blacklist" && input.signedIn && !input.ownerLockout) {
    paragraphs.unshift(
      `${input.signedIn.username} signed in successfully from ${input.ip ?? "this address"} at ${formatWhen(input.signedIn.at, ctx.timeZone)}, and the address was flagged afterwards. It is now on the deny list and its sessions have ended.`,
    );
  }
  if (ctx.suppressed > 0) {
    paragraphs.push(
      `There ${ctx.suppressed === 1 ? "was" : "were"} also ${ctx.suppressed} more alert${ctx.suppressed === 1 ? "" : "s"} like this in the last ${ALERT_DEDUPE_MS / 60_000} minutes. They are recorded in the console but were not emailed one by one.`,
    );
  }

  const details: [string, string][] = [["Event", input.title]];
  details.push(["Portal", `${id.name} ${id.portal} (${ctx.host ?? id.host})`]);
  if (input.signedIn) details.push(["Signed in from this address", `${input.signedIn.username}, ${formatWhen(input.signedIn.at, ctx.timeZone)}`]);
  details.push(["Account", input.user ? input.user.username : input.signedIn ? input.signedIn.username : "None (no account involved)"]);
  if (input.actor && input.actor.id !== input.user?.id) details.push(["Done by", input.actor.username]);
  details.push(["When", formatWhen(ctx.now, ctx.timeZone)]);
  details.push(["IP address", input.ip ?? "Not known"]);
  details.push(["Approximate location", approximateLocation(input) ?? "Not known"]);
  if (input.userAgent) {
    details.push(["Device", describeDevice(input.userAgent)]);
    details.push(["Browser (user agent)", input.userAgent]);
  }
  for (const d of input.details ?? []) details.push(d);

  const denyList = ctx.consoleUrl ? ` (${ctx.consoleUrl}#deny)` : "";
  const actions = input.event === "auto_blacklist" && !input.ownerLockout && (input.signedIn || input.wasAllowlisted)
    ? [
        `If ${input.signedIn ? `${input.signedIn.username} was` : "the people on this address were"} only using the site normally, unblock the address from the console's Deny list${denyList}: each entry shows its evidence, and Unblock can put it back on the allowlist.`,
        "If you don't recognise the activity, leave the block in place, and check the account's sessions and two-step sign-in.",
      ]
    : input.ownerLockout
    ? [
        "If the owner was blocked by mistake, unblock the address from the console's Deny list using another network (for example mobile data), or with the command above.",
        "If the owner's address really did this, leave the block in place and check the owner account's sessions and two-step sign-in.",
      ]
    : [...COPY[input.event].actions];
  if (ctx.auditUrl) actions.push(`Review it in the console: ${ctx.auditUrl}`);
  actions.push(`If something here doesn't look right and you need help, reply to this email or write to ${id.supportEmail}.`);

  const unblockCommand = `npx wrangler d1 execute onlyjewishgirls --remote --command "UPDATE ip_rules SET revoked_at = unixepoch() * 1000 WHERE kind = 'deny' AND ip = '${input.ip ?? "<ip>"}'"`;
  const callout = input.ownerLockout
    ? `This IP address (${input.ip ?? "unknown"}) belongs to the owner's live session, so the owner has been signed out and blocked from it. To unblock it, open the console's Deny list from another network, or run: npx wrangler d1 execute onlyjewishgirls --remote --command "UPDATE ip_rules SET revoked_at = unixepoch() * 1000 WHERE kind = 'deny' AND ip = '${input.ip ?? "<ip>"}'"`
    : input.event === "auto_blacklist" && input.wasAllowlisted
      ? `This IP address (${input.ip ?? "unknown"}) was on the IP allowlist, so the block has taken it off the allowlist and ended its sessions. If it belongs to you or your team, open the console's Deny list from another network to unblock it (and put it back on the allowlist), or run: ${unblockCommand}`
      : undefined;

  const { html, text } = renderNotice(id, {
    heading: headline(input),
    audience: { kind: "admin" },
    callout,
    paragraphs,
    details,
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
 * Records the alert and, unless it is anonymous traffic (shouldEmail) or throttled, emails it. The
 * throttle decision and the row are one statement, so concurrent alerts with the same (event, key), say
 * a burst of parallel requests from one noisy address, can't both see "nothing sent yet" and both send:
 * exactly one is queued per 10 minutes, the rest are recorded as throttled and counted as "and N more
 * like it" in the next email. Anonymous traffic is recorded as `suppressed` and never counts towards the
 * throttle of the emails that do go out. Sign-in codes don't come through here at all.
 */
export async function recordAndSendWith(c: AlertContext, input: AlertInput, host: string): Promise<number | null> {
  const now = input.now ?? Date.now();
  const identity = mailIdentity(c.env);
  const routing = alertRouting(c.env, host);
  const origin = siteOrigin(c, host);
  const auditUrl = input.auditId ? `${origin}/admin#audit/${input.auditId}` : `${origin}/admin#alerts`;
  const email = shouldEmail(input) ? 1 : 0;
  const force = input.event === "test" || input.ownerLockout ? 1 : 0;
  const [row] = await c.db.all<{ id: number; status: string; suppressed: number }>(
    `INSERT INTO security_alerts (at, event, dedupe_key, subject, to_addr, from_addr, status, suppressed, ip, user_id,
                                  username, audit_id, owner_lockout)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, d.status,
       CASE WHEN d.status IN ('throttled', 'suppressed') THEN 0 ELSE (
         SELECT COUNT(*) FROM security_alerts WHERE event = ?2 AND dedupe_key = ?3 AND status = 'throttled'
           AND at > COALESCE((SELECT MAX(at) FROM security_alerts WHERE event = ?2 AND dedupe_key = ?3 AND status NOT IN ('throttled', 'suppressed')), 0)
       ) END,
       ?7, ?8, ?9, ?10, ?11
     FROM (SELECT CASE
             WHEN ?14 = 0 THEN 'suppressed'
             WHEN ?12 = 0 AND EXISTS (
               SELECT 1 FROM security_alerts WHERE event = ?2 AND dedupe_key = ?3 AND status NOT IN ('throttled', 'suppressed') AND at > ?1 - ?13
             ) THEN 'throttled'
             ELSE 'queued' END AS status) d
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
    ALERT_DEDUPE_MS,
    email,
  );
  if (!row) return null;
  if (row.status === "throttled" || row.status === "suppressed") return row.id;
  const mail = composeAlert(input, {
    identity,
    timeZone: c.timeZone,
    auditUrl,
    suppressed: row.suppressed,
    now,
    host: host.replace(/:\d+$/, "") || undefined,
    consoleUrl: `${origin}/admin`,
  });
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
