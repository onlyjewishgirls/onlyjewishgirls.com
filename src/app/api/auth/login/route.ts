import { NextResponse } from "next/server";
import { isValidTimeZone } from "@/lib/streak/dates";
import { api, clientIp, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { mfaState, nextStep } from "@/server/mfa";
import { burnPasswordCheck, verifyPassword } from "@/server/passwords";
import { rateLimit, resetRateLimit } from "@/server/rate-limit";
import { startSession } from "@/server/session";
import { findUserByLogin, updateTimeZone } from "@/server/users";

const WINDOW_MS = 15 * 60_000;
const BAD_LOGIN = "Incorrect username/email or password.";

export const POST = api(async (req) => {
  const body = await readJson(req);
  const identifier = str(body.identifier).trim().toLowerCase();
  const password = str(body.password);
  if (!identifier || !password) return jsonError(400, "Enter your username or email and your password.");

  const ipLimit = rateLimit(`login:ip:${clientIp(req)}`, 30, WINDOW_MS);
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfterSeconds);

  const user = findUserByLogin(identifier);
  // Keyed by account, so switching between username and email doesn't buy extra guesses.
  const accountKey = `login:account:${user ? user.id : identifier}`;
  const accountLimit = rateLimit(accountKey, 10, WINDOW_MS);
  if (!accountLimit.ok) return tooManyRequests(accountLimit.retryAfterSeconds);

  if (!user) {
    await burnPasswordCheck(password);
    return jsonError(401, BAD_LOGIN);
  }
  if (!(await verifyPassword(password, user.passwordHash))) return jsonError(401, BAD_LOGIN);

  resetRateLimit(accountKey);
  const timeZone = str(body.timeZone);
  if (isValidTimeZone(timeZone) && timeZone !== user.timeZone) updateTimeZone(user.id, timeZone);

  await startSession(user.id, "password");
  return NextResponse.json({ next: nextStep("password", mfaState(user)) });
});
