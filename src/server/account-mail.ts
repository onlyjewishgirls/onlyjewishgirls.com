import "server-only";
import { describeDevice } from "@/lib/admin/format";
import { requestInfo } from "./events";
import { approximateLocation, formatWhen, renderNotice, subjectLine, type MailIdentity } from "./mail-template";
import { getSettings } from "./settings";

/**
 * The emails a member gets about their own account (PORTAL-STANDARD §6): sign-in codes, password
 * reset links, "your password was changed", and a message an administrator writes from the console.
 * Each says who it is from, why this address gets it, what happened, when (portal zone and UTC),
 * from which IP address and roughly where, and what to do if it wasn't them. The compose functions
 * are pure (exported for tests); `requestFacts` reads the current request.
 */

export interface ComposedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Where and when the request behind an email came from. */
export interface RequestFacts {
  now: number;
  timeZone: string;
  ip: string | null;
  location: string | null;
  device: string | null;
}

export async function requestFacts(now = Date.now()): Promise<RequestFacts> {
  let timeZone = "America/New_York";
  try {
    timeZone = (await getSettings()).time_zone;
  } catch {
    // Keep the default; an email never fails for want of a setting.
  }
  try {
    const info = await requestInfo();
    return {
      now,
      timeZone,
      ip: info.ip,
      location: approximateLocation(info),
      device: info.userAgent ? describeDevice(info.userAgent) : null,
    };
  } catch {
    return { now, timeZone, ip: null, location: null, device: null };
  }
}

const NOT_KNOWN = "Not known";

function requestRows(f: RequestFacts, whenLabel: string): [string, string][] {
  return [
    [whenLabel, formatWhen(f.now, f.timeZone)],
    ["IP address", f.ip ?? NOT_KNOWN],
    ["Approximate location", f.location ?? NOT_KNOWN],
    ["Device", f.device ?? NOT_KNOWN],
  ];
}

function portalRow(id: MailIdentity): [string, string] {
  return ["Portal", `${id.name} ${id.portal} (${id.website})`];
}

function shortTime(ms: number, timeZone: string): string {
  try {
    return `${new Date(ms).toLocaleTimeString("en-US", { timeZone, timeStyle: "short" })} ${shortZone(ms, timeZone)} (${new Date(ms).toISOString().slice(11, 16)} UTC)`;
  } catch {
    return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
  }
}

function shortZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** The email-code second factor. Never delayed or digested. */
export function composeCodeEmail(
  id: MailIdentity,
  input: { username: string; code: string; minutes: number; facts: RequestFacts },
): ComposedEmail {
  const f = input.facts;
  const expires = shortTime(f.now + input.minutes * 60_000, f.timeZone);
  const { html, text } = renderNotice(id, {
    heading: "Your sign-in code",
    audience: { kind: "user", username: input.username },
    code: { intro: `Someone, hopefully you, is signing in to the account "${input.username}" on the ${id.name} ${id.portal}. Enter this code to finish:`, value: input.code },
    after: [
      `The code expires in ${input.minutes} minutes, at ${expires}, and works once.`,
      "We will never ask you for this code. Don't share it with anyone, including anyone who says they work for us.",
    ],
    details: [["Account", input.username], portalRow(id), ...requestRows(f, "Requested")],
    actions: [
      "Enter the code on the sign-in page you have open.",
      "If you didn't try to sign in, you can ignore this email. Nobody can use the code without your password.",
      `If you keep getting codes you didn't ask for, someone may know your password: change it the next time you sign in, or write to ${id.supportEmail}.`,
    ],
  });
  return { subject: subjectLine(id, "Sign-in code requested"), html, text };
}

/**
 * A password reset link. `byAdmin`: an administrator sent it from the console, rather than the member
 * asking for it on the "Forgot password?" page.
 */
export function composeResetEmail(
  id: MailIdentity,
  input: { firstName: string; username: string; url: string; minutes: number; byAdmin: boolean; facts: RequestFacts },
): ComposedEmail {
  const f = input.facts;
  const expires = shortTime(f.now + input.minutes * 60_000, f.timeZone);
  const asked = input.byAdmin
    ? `An administrator of the ${id.name} ${id.portal} sent you this link so you can choose a new password for your account "${input.username}".`
    : `You asked to reset the password for your account "${input.username}" on the ${id.name} ${id.portal}.`;
  const { html, text } = renderNotice(id, {
    heading: input.byAdmin ? "Choose a new password" : "Reset your password",
    audience: { kind: "user", username: input.username },
    paragraphs: [`Hi ${input.firstName},`, asked],
    link: { intro: "To choose a new password, open this link:", url: input.url },
    after: [
      `The link works once and expires in ${input.minutes} minutes, at ${expires}.`,
      input.byAdmin
        ? "If you weren't expecting this, ignore this email: your password is unchanged."
        : "If you didn't ask for this, ignore this email: your password is unchanged. Nobody can sign in without your passkey or authenticator app as well.",
    ],
    details: input.byAdmin
      ? [["Account", input.username], portalRow(id), ["Sent", formatWhen(f.now, f.timeZone)], ["Sent by", "An administrator, from the console"]]
      : [["Account", input.username], portalRow(id), ...requestRows(f, "Requested")],
    actions: [
      "Open the link on the device you want to use, and choose a new password there.",
      "We will never ask for your password by email, and this link only works on our own website.",
      `If you didn't expect this email, you don't need to do anything. If it keeps happening, write to ${id.supportEmail}.`,
    ],
  });
  return { subject: subjectLine(id, input.byAdmin ? "Password reset link sent by an administrator" : "Password reset requested"), html, text };
}

export function composePasswordChangedEmail(
  id: MailIdentity,
  input: { firstName: string; username: string; keptThisDevice: boolean; facts: RequestFacts },
): ComposedEmail {
  const { html, text } = renderNotice(id, {
    heading: "Your password was changed",
    audience: { kind: "user", username: input.username },
    paragraphs: [
      `Hi ${input.firstName},`,
      `The password for your account "${input.username}" on the ${id.name} ${id.portal} was changed, and you were signed out on every ${input.keptThisDevice ? "other " : ""}device.`,
    ],
    details: [["Account", input.username], portalRow(id), ...requestRows(input.facts, "Changed")],
    actions: [
      "If you made this change, you don't need to do anything.",
      `If you didn't, type ${id.website} into your browser yourself, choose "Forgot password?" on the sign-in page to pick a new password, and make sure your email account is secure.`,
      `If you need help, reply to this email or write to ${id.supportEmail}.`,
    ],
  });
  return { subject: subjectLine(id, "Your password was changed"), html, text };
}

/** A message an administrator writes to one member from the console ("Email this person"). */
export function composeMessageEmail(
  id: MailIdentity,
  input: { username: string; subject: string; message: string; facts: RequestFacts },
): ComposedEmail {
  const paragraphs = input.message.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const { html, text } = renderNotice(id, {
    heading: input.subject,
    audience: { kind: "user", username: input.username },
    paragraphs: [`An administrator of the ${id.name} ${id.portal} sent you this message:`, ...paragraphs],
    details: [["Account", input.username], portalRow(id), ["Sent", formatWhen(input.facts.now, input.facts.timeZone)]],
    actions: [`To answer, reply to this email or write to ${id.supportEmail}.`],
  });
  return { subject: `[${id.name}] ${input.subject}`, html, text };
}
