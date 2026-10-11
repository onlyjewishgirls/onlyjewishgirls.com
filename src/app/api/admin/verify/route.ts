import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { requireAdminApi } from "@/server/admin";
import { decrypt } from "@/server/crypto";
import { logEvent } from "@/server/events";
import { api, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { MFA_FAILURES_PER_HOUR, mfaFailureKey } from "@/server/mfa-routes";
import { isRateLimited, rateLimit } from "@/server/rate-limit";
import { markVerified, takeChallenge } from "@/server/session";
import { verifyTotp } from "@/server/totp";
import { claimTotpStep } from "@/server/users";
import { verifyAuthentication } from "@/server/webauthn";

/**
 * Re-checks a second factor before admin changes, so a signed-in device left
 * unattended can't be used to change other people's accounts. Wrong attempts
 * count toward the same hourly limit as signing in.
 */
export const POST = api(async (req) => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { session, user } = guard.ctx;

  const failureKey = mfaFailureKey(user.id);
  const limit = await isRateLimited(failureKey, MFA_FAILURES_PER_HOUR);
  if (limit.limited) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
  const method = body.method === "totp" ? "totp" : "passkey";
  let verified = false;
  if (method === "totp") {
    if (!user.totpSecretEnc) return jsonError(400, "You don't have an authenticator app connected.");
    const step = verifyTotp(decrypt(user.totpSecretEnc), str(body.code), Date.now(), user.totpLastStep);
    verified = step !== null && (await claimTotpStep(user.id, step));
  } else {
    const challenge = await takeChallenge(session);
    if (!challenge) return jsonError(400, "That took too long. Please try again.");
    try {
      verified = await verifyAuthentication(req, user, body.response as AuthenticationResponseJSON, challenge);
    } catch (error) {
      console.warn("Admin passkey check rejected:", (error as Error).message);
    }
  }

  if (!verified) {
    await rateLimit(failureKey, MFA_FAILURES_PER_HOUR, 60 * 60_000);
    await logEvent("signin.mfa_failed", { user, detail: { method, context: "admin" } });
    return jsonError(400, method === "totp" ? "That code didn't work. Wait for a new one and try again." : "That passkey didn't work.");
  }
  await markVerified(session);
  await logEvent("admin.verified", { user, actor: user, detail: { method } });
  return NextResponse.json({ ok: true });
});
