/**
 * The mail transport: Plunk, the only provider (PORTAL-STANDARD §8), with the Worker's variables
 * passed in. It imports nothing from Next.js or OpenNext, so the Worker entry (src/worker/captcha.ts,
 * the CAPTCHA wall's daily "wall is off" alert) can send through it before the app runs. The app uses
 * it through mailer.ts, which supplies the request's variables.
 */

import { escapeHtml, mailIdentity, type IdentityEnv } from "./mail-template";

/** Plunk's current platform. PLUNK_API_URL overrides it (e.g. a self-hosted Plunk). */
const PLUNK_ENDPOINT = "https://next-api.useplunk.com/v1/send";
const TIMEOUT_MS = 8_000;
/** Sender when EMAIL_FROM isn't set, so PLUNK_API_KEY alone is a complete mail set-up (PORTAL-STANDARD §8). Only its address is used: the name is the business name. */
export const DEFAULT_FROM = "OnlyJewishGirls <no-reply@onlyjewishgirls.com>";
/** What security_alerts.provider and the audit log record for a send. */
export const PROVIDER = "plunk";

/**
 * The pause before the one retry after a network error or a Plunk 5xx. Tests set delayMs to 0.
 * There is no fallback provider: a send that still fails is reported as failed.
 */
export const mailRetry = { delayMs: 400 };

/** The variables the transport reads (plus the sender identity, mail-template.ts). */
export interface MailEnv extends IdentityEnv {
  PLUNK_API_KEY?: string;
  PLUNK_API_URL?: string;
  EMAIL_FROM?: string;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Delivery {
  ok: boolean;
  /** "plunk" once a send was attempted; null when mail isn't configured. */
  provider: string | null;
  error: string | null;
}

/** "Name <a@b.c>" as Plunk takes it: { name, email }, or the bare address. */
export function plunkFrom(from: string): string | { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return from.trim();
  return m[1].trim() ? { name: m[1].trim(), email: m[2].trim() } : m[2].trim();
}

/** The address part of "Name <a@b.c>" (or a bare address). */
export function addressOf(from: string): string {
  const parsed = plunkFrom(from);
  return typeof parsed === "string" ? parsed : parsed.email;
}

/** Mail is configured exactly when PLUNK_API_KEY is set (EMAIL_FROM has a default). */
export function mailConfigured(env: MailEnv): boolean {
  return Boolean(env.PLUNK_API_KEY?.trim());
}

type Attempt = { ok: true } | { ok: false; retry: boolean; error: string };

async function attempt(url: string, key: string, body: string, to: string): Promise<Attempt> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const text = (await res.text()).slice(0, 300);
    console.error(`Email to ${to} via Plunk failed: ${res.status} ${text}`);
    return { ok: false, retry: res.status >= 500, error: `Plunk answered ${res.status}: ${text}` };
  } catch (error) {
    console.error(`Email to ${to} via Plunk failed:`, (error as Error).message);
    return { ok: false, retry: true, error: `Plunk: ${(error as Error).message}` };
  }
}

/**
 * Sends through Plunk (PLUNK_API_KEY). A network error or a 5xx is retried once after a short pause;
 * a 4xx is not. It never throws: a failure comes back as { ok: false } for the caller to record.
 *
 * Every email says who it is from (PORTAL-STANDARD §6): `from` is { name: the business name,
 * email: the sender address }, where the address is `fromEmail` (security alerts: ALERTS_EMAIL_FROM),
 * else the address in EMAIL_FROM, else DEFAULT_FROM's; and `reply` is the support address. Nothing
 * else is sent: no `subscribed`, no tracking, so Plunk treats it as transactional mail.
 * Without a key, local development prints the email to the terminal instead.
 */
export async function deliverEmailWith(
  env: MailEnv,
  email: Email,
  { local, fromEmail }: { local: boolean; fromEmail?: string },
): Promise<Delivery> {
  const id = mailIdentity(env);
  const from = { name: id.name, email: fromEmail?.trim() || addressOf(env.EMAIL_FROM?.trim() || DEFAULT_FROM) };
  if (!mailConfigured(env)) {
    if (local) {
      console.log(`\n[email not configured — would send]\nFrom: ${from.name} <${from.email}>\nReply-To: ${id.supportEmail}\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    } else {
      console.error("Email is not configured: set the PLUNK_API_KEY secret on the Worker.");
    }
    return { ok: false, provider: null, error: "Email is not configured: set the PLUNK_API_KEY secret on the Worker." };
  }
  const url = env.PLUNK_API_URL?.trim() || PLUNK_ENDPOINT;
  const key = env.PLUNK_API_KEY!.trim();
  // Plunk takes the HTML only and makes the text part from it (mail-template.ts keeps it simple).
  const body = JSON.stringify({ from, reply: id.supportEmail, to: email.to, subject: email.subject, body: email.html });
  let result = await attempt(url, key, body, email.to);
  if (!result.ok && result.retry) {
    if (mailRetry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, mailRetry.delayMs));
    result = await attempt(url, key, body, email.to);
  }
  return result.ok ? { ok: true, provider: PROVIDER, error: null } : { ok: false, provider: PROVIDER, error: result.error };
}

export { escapeHtml };
