import "server-only";
import type { NextRequest } from "next/server";
import { randomInt } from "node:crypto";
import { sha256 } from "./crypto";
import { batch, first, run } from "./db";
import { APP_NAME, isLocalHost } from "./env";
import { deliverEmail, emailConfigured, simpleHtml } from "./mailer";
import type { User } from "./users";

/**
 * Email codes, the third second factor (PORTAL-STANDARD §3: passkey, authenticator
 * app, email). 6 digits, 10 minutes, single use, stored only as a hash. Sent through
 * the existing Resend/Plunk transport; never offered when email isn't configured.
 */
export const EMAIL_CODE_MINUTES = 10;
export const EMAIL_CODES_PER_HOUR = 5;
export const EMAIL_CODE_RESEND_SECONDS = 60;
/**
 * After a password is reset from an emailed link, email codes stay off this long, so
 * someone holding only the mailbox can't do both halves of a sign-in.
 */
export const EMAIL_AFTER_RESET_MS = 24 * 60 * 60_000;

const hashCode = (userId: number, code: string) => sha256(`email-otp:${userId}:${code}`);

export type EmailOtpAvailability = { ok: true } | { ok: false; reason: string };

/** Whether this account can use an email code right now, and if not, exactly why. */
export async function emailOtpAvailability(user: User, now = Date.now()): Promise<EmailOtpAvailability> {
  if (!emailConfigured()) return { ok: false, reason: "Email codes aren't available: this site's email isn't configured." };
  if (!user.emailOtpEnabled) return { ok: false, reason: "Email codes are turned off for this account by an administrator." };
  const reset = await first("SELECT 1 FROM password_resets WHERE user_id = ? AND used_at IS NOT NULL AND used_at > ?", user.id, now - EMAIL_AFTER_RESET_MS);
  if (reset) {
    return {
      ok: false,
      reason: "Email codes are off for 24 hours after a password reset by email, so a mailbox alone can't open the account. Use your passkey, authenticator app or a recovery code.",
    };
  }
  return { ok: true };
}

export type SendResult = { ok: true; to: string } | { ok: false; code: "rate_limited" | "email_unavailable" | "delivery_failed"; error: string };

export async function sendEmailCode(req: NextRequest, user: User, now = Date.now()): Promise<SendResult> {
  const available = await emailOtpAvailability(user, now);
  if (!available.ok) return { ok: false, code: "email_unavailable", error: available.reason };
  const recent = await first<{ n: number; last: number | null }>(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM email_codes WHERE user_id = ? AND created_at > ?",
    user.id,
    now - 60 * 60_000,
  );
  if (recent?.last && now - recent.last < EMAIL_CODE_RESEND_SECONDS * 1000) {
    const wait = Math.ceil((EMAIL_CODE_RESEND_SECONDS * 1000 - (now - recent.last)) / 1000);
    return { ok: false, code: "rate_limited", error: `A code was sent less than a minute ago. Wait ${wait} s before asking for another.` };
  }
  if ((recent?.n ?? 0) >= EMAIL_CODES_PER_HOUR) {
    return { ok: false, code: "rate_limited", error: `${EMAIL_CODES_PER_HOUR} codes were already emailed to this account in the last hour. Use another method or try later.` };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // A new code replaces any earlier unused one (which then reads as expired).
  await batch([
    ["UPDATE email_codes SET expires_at = ? WHERE user_id = ? AND used_at IS NULL AND expires_at > ?", now, user.id, now],
    [
      "INSERT INTO email_codes (user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
      user.id,
      hashCode(user.id, code),
      now,
      now + EMAIL_CODE_MINUTES * 60_000,
    ],
  ]);
  const lines = [
    `Your ${APP_NAME} sign-in code is ${code}.`,
    `It works once and expires in ${EMAIL_CODE_MINUTES} minutes. If you didn't just sign in, someone has your password: change it now.`,
  ];
  const delivery = await deliverEmail(
    { to: user.email, subject: `${code} is your ${APP_NAME} sign-in code`, text: `${lines.join("\n\n")}\n`, html: simpleHtml(lines) },
    { local: isLocalHost(new URL(req.url).host) },
  );
  if (!delivery.ok) return { ok: false, code: "delivery_failed", error: `The code couldn't be emailed: ${delivery.error}` };
  return { ok: true, to: user.email };
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** Single use, checked and claimed in one statement. The refusal says exactly why. */
export async function checkEmailCode(user: User, typed: string, now = Date.now()): Promise<CheckResult> {
  const code = typed.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "Enter the 6-digit code from the email." };
  const hash = hashCode(user.id, code);
  const { changes } = await run(
    "UPDATE email_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?",
    now,
    user.id,
    hash,
    now,
  );
  if (changes === 1) return { ok: true };
  const row = await first<{ used_at: number | null; expires_at: number }>(
    "SELECT used_at, expires_at FROM email_codes WHERE user_id = ? AND code_hash = ? ORDER BY id DESC LIMIT 1",
    user.id,
    hash,
  );
  if (row?.used_at) return { ok: false, reason: "That code was already used. Request a new one." };
  if (row) return { ok: false, reason: "That code has expired; request a new one." };
  return { ok: false, reason: "That code is incorrect." };
}
