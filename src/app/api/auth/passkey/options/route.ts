import { NextResponse } from "next/server";
import { run } from "@/server/db";
import { api, clientIp, tooManyRequests } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { discoverableOptions } from "@/server/webauthn";

/** "Sign in with a passkey" (usernameless, also used by passkey autofill): a single-use challenge. */
export const POST = api(async (req) => {
  const ip = clientIp(req);
  const limit = await rateLimit(`passkey-login:ip:${ip}`, 30, 15 * 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds, ip, "passkey sign-in attempts");
  const now = Date.now();
  const options = await discoverableOptions(req);
  await run("DELETE FROM webauthn_challenges WHERE expires_at <= ?", now);
  await run("INSERT INTO webauthn_challenges (challenge, expires_at) VALUES (?, ?)", options.challenge, now + 5 * 60_000);
  return NextResponse.json(options);
});
