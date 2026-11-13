/**
 * The mail transport (Plunk first, Resend as the fallback; PORTAL-STANDARD §8), with the Worker's
 * variables passed in. It imports nothing from Next.js or OpenNext, so the Worker entry
 * (src/worker/captcha.ts, the CAPTCHA wall's daily "wall is off" alert) can send through it before
 * the app runs. The app uses it through mailer.ts, which supplies the request's variables.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** Plunk's current platform. PLUNK_API_URL overrides it (e.g. a self-hosted Plunk). */
const PLUNK_ENDPOINT = "https://next-api.useplunk.com/v1/send";
const TIMEOUT_MS = 8_000;
/** Sender when EMAIL_FROM isn't set, so PLUNK_API_KEY alone is a complete mail set-up (PORTAL-STANDARD §8). */
export const DEFAULT_FROM = "OnlyJewishGirls <no-reply@onlyjewishgirls.com>";

/** The variables the transport reads. */
export interface MailEnv {
  EMAIL_API_KEY?: string;
  PLUNK_API_KEY?: string;
  PLUNK_API_URL?: string;
  EMAIL_PRIMARY?: string;
  EMAIL_FROM?: string;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Provider {
  name: "Plunk" | "Resend";
  url: string;
  key: string;
  body: Record<string, unknown>;
}

export interface Delivery {
  ok: boolean;
  /** The provider that accepted it, or that failed last. */
  provider: string | null;
  error: string | null;
}

/** "Name <a@b.c>" as Plunk takes it: { name, email }, or the bare address. */
export function plunkFrom(from: string): string | { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return from.trim();
  return m[1].trim() ? { name: m[1].trim(), email: m[2].trim() } : m[2].trim();
}

/**
 * Which providers to try, in order. Plunk is the primary whenever PLUNK_API_KEY is set, with Resend
 * (EMAIL_API_KEY) as the fallback on any error; with only one key, that one is used alone. Setting
 * EMAIL_PRIMARY to "resend" puts Resend first instead.
 */
export function providersFor(env: MailEnv, email: Email, from: string): Provider[] {
  const { EMAIL_API_KEY: resendKey, PLUNK_API_KEY: plunkKey, EMAIL_PRIMARY: primary, PLUNK_API_URL: plunkUrl } = env;
  const list: Provider[] = [];
  if (plunkKey) {
    // Plunk takes the HTML only and makes the text part from it.
    list.push({
      name: "Plunk",
      url: plunkUrl?.trim() || PLUNK_ENDPOINT,
      key: plunkKey,
      body: { from: plunkFrom(from), to: email.to, subject: email.subject, body: email.html },
    });
  }
  if (resendKey) {
    list.push({ name: "Resend", url: RESEND_ENDPOINT, key: resendKey, body: { from, to: [email.to], subject: email.subject, text: email.text, html: email.html } });
  }
  if (primary?.toLowerCase() === "resend") list.reverse();
  return list;
}

/** Mail works when either key is set; PLUNK_API_KEY alone is enough (EMAIL_FROM has a default). */
export function mailConfigured(env: MailEnv): boolean {
  return Boolean(env.EMAIL_API_KEY || env.PLUNK_API_KEY);
}

/**
 * Sends through Plunk (PLUNK_API_KEY), with Resend (EMAIL_API_KEY) as the fallback when both are set.
 * The sender is the `from` passed in (security alerts), else EMAIL_FROM, else DEFAULT_FROM. Without
 * a key, local development prints the email to the terminal instead.
 */
export async function deliverEmailWith(
  env: MailEnv,
  email: Email,
  { local, from: fromOverride }: { local: boolean; from?: string },
): Promise<Delivery> {
  const from = fromOverride || env.EMAIL_FROM || DEFAULT_FROM;
  if (!mailConfigured(env)) {
    if (local) {
      console.log(`\n[email not configured — would send]\nFrom: ${from}\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    } else {
      console.error("Email is not configured: set the PLUNK_API_KEY secret on the Worker.");
    }
    return { ok: false, provider: null, error: "Email is not configured: set the PLUNK_API_KEY secret on the Worker." };
  }
  let last: Delivery = { ok: false, provider: null, error: "No email provider is configured." };
  for (const provider of providersFor(env, email, from)) {
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(provider.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, provider: provider.name, error: null };
      const text = (await res.text()).slice(0, 300);
      console.error(`Email to ${email.to} via ${provider.name} failed: ${res.status} ${text}`);
      last = { ok: false, provider: provider.name, error: `${provider.name} answered ${res.status}: ${text}` };
    } catch (error) {
      console.error(`Email to ${email.to} via ${provider.name} failed:`, (error as Error).message);
      last = { ok: false, provider: provider.name, error: `${provider.name}: ${(error as Error).message}` };
    }
  }
  return last;
}

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
