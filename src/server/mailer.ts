import "server-only";
import { cfEnv } from "./env";
import { deliverEmailWith, mailConfigured, type Delivery, type Email } from "./mail-core";
import { mailIdentity, type MailIdentity } from "./mail-template";

// The transport itself is in mail-core.ts, and the layout in mail-template.ts (neither imports Next.js,
// so the Worker entry can use them too).
export { DEFAULT_FROM, escapeHtml, plunkFrom, type Delivery, type Email } from "./mail-core";
export { approximateLocation, formatWhen, renderNotice, subjectLine, type Notice } from "./mail-template";

/** Mail is configured exactly when PLUNK_API_KEY is set (EMAIL_FROM has a default). */
export function emailConfigured(): boolean {
  return mailConfigured(cfEnv());
}

/** The business name, legal name, website and support address every email carries. */
export function siteIdentity(): MailIdentity {
  return mailIdentity(cfEnv());
}

/**
 * Sends through Plunk (PLUNK_API_KEY), retrying once on a network error or a 5xx; no fallback provider.
 * The sender is { name: the business name, email: `fromEmail`, else EMAIL_FROM's address, else
 * DEFAULT_FROM's }, and replies go to the support address. Without a key, local development prints
 * the email to the terminal instead.
 */
export function deliverEmail(email: Email, options: { local: boolean; fromEmail?: string }): Promise<Delivery> {
  return deliverEmailWith(cfEnv(), email, options);
}

export async function sendEmail(email: Email, options: { local: boolean; fromEmail?: string }): Promise<boolean> {
  return (await deliverEmail(email, options)).ok;
}
