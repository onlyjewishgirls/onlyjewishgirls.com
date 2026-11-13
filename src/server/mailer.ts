import "server-only";
import { cfEnv } from "./env";
import { deliverEmailWith, escapeHtml, mailConfigured, providersFor, type Delivery, type Email, type Provider } from "./mail-core";

// The transport itself is in mail-core.ts (no Next.js imports, so the Worker entry can use it too).
export { DEFAULT_FROM, escapeHtml, plunkFrom, type Delivery, type Email } from "./mail-core";

/** Which providers to try, in order (see providersFor). */
export function providers(email: Email, from: string): Provider[] {
  return providersFor(cfEnv(), email, from);
}

/** Mail works when either key is set; PLUNK_API_KEY alone is enough (EMAIL_FROM has a default). */
export function emailConfigured(): boolean {
  return mailConfigured(cfEnv());
}

/**
 * Sends through Plunk (PLUNK_API_KEY), with Resend (EMAIL_API_KEY) as the fallback when both are set.
 * The sender is the `from` passed in (security alerts), else EMAIL_FROM, else DEFAULT_FROM. Without
 * a key, local development prints the email to the terminal instead.
 */
export function deliverEmail(email: Email, options: { local: boolean; from?: string }): Promise<Delivery> {
  return deliverEmailWith(cfEnv(), email, options);
}

export async function sendEmail(email: Email, options: { local: boolean; from?: string }): Promise<boolean> {
  return (await deliverEmail(email, options)).ok;
}

/** A plain, readable HTML version of a short message with an optional button. */
export function simpleHtml(paragraphs: string[], button?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  const action = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="background:#1f3fae;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>`
    : "";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#1c1b22;max-width:520px">${body}${action}</div>`;
}
