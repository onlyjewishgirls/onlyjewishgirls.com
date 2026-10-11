import { NextResponse } from "next/server";
import { logEvent } from "@/server/events";
import { api, clientIp, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { RESET_LINK_MINUTES, sendPasswordResetEmail } from "@/server/password-reset";
import { rateLimit } from "@/server/rate-limit";
import { findUserByLogin } from "@/server/users";

const HOUR = 60 * 60_000;

/** Always gives the same answer, so it can't be used to find out which accounts exist. */
export const POST = api(async (req) => {
  const identifier = str((await readJson(req)).identifier).trim().toLowerCase();
  if (!identifier) return jsonError(400, "Enter your username or email.");

  const ipLimit = await rateLimit(`forgot:ip:${clientIp(req)}`, 10, HOUR);
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfterSeconds);

  const user = await findUserByLogin(identifier);
  // Per account: at most 3 emails an hour, silently, so nobody can flood someone's inbox.
  // Suspended accounts get no email, but the answer is the same.
  if (user && user.suspendedAt === null && (await rateLimit(`forgot:account:${user.id}`, 3, HOUR)).ok) {
    await sendPasswordResetEmail(req, user);
    await logEvent("password.reset_requested", { user });
  }
  return NextResponse.json({
    message: `If that account exists, we've emailed a link to reset its password. The link expires in ${RESET_LINK_MINUTES} minutes.`,
  });
});
