import "server-only";
import { cfEnv } from "./env";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 8_000;

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends through Resend (the same service the employees portal uses). Needs the
 * EMAIL_API_KEY secret and EMAIL_FROM variable on the Worker. Without them,
 * local development prints the email to the terminal instead.
 */
export async function sendEmail(email: Email, { local }: { local: boolean }): Promise<boolean> {
  const { EMAIL_API_KEY: apiKey, EMAIL_FROM: from } = cfEnv();
  if (!apiKey || !from) {
    if (local) {
      console.log(`\n[email not configured — would send]\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n`);
    } else {
      console.error("Email is not configured: set the EMAIL_API_KEY secret and EMAIL_FROM variable on the Worker.");
    }
    return false;
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error(`Email to ${email.to} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.ok;
  } catch (error) {
    console.error(`Email to ${email.to} failed:`, (error as Error).message);
    return false;
  }
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
