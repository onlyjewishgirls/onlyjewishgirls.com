import "server-only";
import { cfEnv } from "./env";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const PLUNK_ENDPOINT = "https://next-api.useplunk.com/v1/send";
const TIMEOUT_MS = 8_000;

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface Provider {
  name: string;
  url: string;
  key: string;
  body: Record<string, unknown>;
}

/** "Name <a@b.c>" as Plunk takes it: { name, email }. */
function plunkFrom(from: string): string | { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return from;
  return m[1] ? { name: m[1].trim(), email: m[2].trim() } : m[2].trim();
}

/** Which providers to try, in order: Resend then Plunk, or Plunk first when EMAIL_PRIMARY is "plunk". */
function providers(email: Email, from: string): Provider[] {
  const { EMAIL_API_KEY: resendKey, PLUNK_API_KEY: plunkKey, EMAIL_PRIMARY: primary } = cfEnv();
  const list: Provider[] = [];
  if (resendKey) {
    list.push({ name: "Resend", url: RESEND_ENDPOINT, key: resendKey, body: { from, to: [email.to], subject: email.subject, text: email.text, html: email.html } });
  }
  if (plunkKey) {
    // Plunk takes the HTML only and makes the text part from it.
    list.push({ name: "Plunk", url: PLUNK_ENDPOINT, key: plunkKey, body: { from: plunkFrom(from), to: email.to, subject: email.subject, body: email.html } });
  }
  if (primary?.toLowerCase() === "plunk") list.reverse();
  return list;
}

export function emailConfigured(): boolean {
  const { EMAIL_API_KEY, PLUNK_API_KEY, EMAIL_FROM } = cfEnv();
  return Boolean((EMAIL_API_KEY || PLUNK_API_KEY) && EMAIL_FROM);
}

/**
 * Sends through Resend (the same service the employees portal uses), with Plunk as the backup
 * when Resend fails. Needs the EMAIL_API_KEY and/or PLUNK_API_KEY secret and the EMAIL_FROM
 * variable on the Worker. Without them, local development prints the email to the terminal instead.
 */
export async function sendEmail(email: Email, { local }: { local: boolean }): Promise<boolean> {
  const { EMAIL_FROM: from } = cfEnv();
  if (!emailConfigured() || !from) {
    if (local) {
      console.log(`\n[email not configured — would send]\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    } else {
      console.error("Email is not configured: set the EMAIL_API_KEY or PLUNK_API_KEY secret and EMAIL_FROM variable on the Worker.");
    }
    return false;
  }
  for (const provider of providers(email, from)) {
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(provider.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return true;
      console.error(`Email to ${email.to} via ${provider.name} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    } catch (error) {
      console.error(`Email to ${email.to} via ${provider.name} failed:`, (error as Error).message);
    }
  }
  return false;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain, readable HTML version of a short message with an optional button. */
export function simpleHtml(paragraphs: string[], button?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join("");
  const action = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="background:#1f3fae;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>`
    : "";
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#1c1b22;max-width:520px">${body}${action}</div>`;
}
