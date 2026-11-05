import { NextResponse } from "next/server";
import { logEvent } from "@/server/events";
import { api, clientIp, fail, readJson, str, tooManyRequests } from "@/server/http";
import { RESET_LINK_MINUTES, sendPasswordResetEmail } from "@/server/password-reset";
import { isRateLimited, rateLimit } from "@/server/rate-limit";
import { findUserByLogin } from "@/server/users";
import { formatDuration, maskEmail } from "@/lib/security";

const HOUR = 60 * 60_000;
const EMAILS_PER_HOUR = 3;

/**
 * Says exactly what happened (PORTAL-STANDARD §2 replaced the old "same answer
 * whether or not the account exists" policy).
 */
export const POST = api(async (req) => {
  const typed = str((await readJson(req)).identifier).trim();
  const identifier = typed.toLowerCase();
  if (!identifier) return fail(400, "validation", "Enter your username or email.", "identifier");

  const ip = clientIp(req);
  const ipLimit = await rateLimit(`forgot:ip:${ip}`, 10, HOUR);
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfterSeconds, ip, "reset requests");

  const user = await findUserByLogin(identifier);
  if (!user) return fail(404, "no_account", `No account exists with the username or email "${typed.slice(0, 80)}".`, "identifier");
  if (user.suspendedAt !== null) {
    return fail(
      403,
      "account_suspended",
      `This account is suspended by an administrator, so reset links are off.${user.suspendedReason ? ` Reason: ${user.suspendedReason}` : ""}`,
    );
  }
  const key = `forgot:account:${user.id}`;
  const already = await isRateLimited(key, EMAILS_PER_HOUR);
  if (already.limited) {
    return fail(
      429,
      "rate_limited",
      `${EMAILS_PER_HOUR} reset emails were already sent to ${user.username} in the last hour. Try again in ${formatDuration(already.retryAfterSeconds)}, or use the newest email.`,
    );
  }
  await rateLimit(key, EMAILS_PER_HOUR, HOUR);
  await sendPasswordResetEmail(req, user);
  await logEvent("password.reset_requested", { user });
  return NextResponse.json({
    ok: true,
    message: `We emailed a reset link for ${user.username} to ${maskEmail(user.email)}. It works once and expires in ${RESET_LINK_MINUTES} minutes.`,
  });
});
