import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { api, fail, readJson } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";
import { takeChallenge } from "@/server/session";
import { checkAuthentication } from "@/server/webauthn";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  const challenge = await takeChallenge(guard.ctx.session);
  if (!challenge) return fail(400, "passkey_failed", "The passkey request expired (5 minutes). Try again.");

  const body = await readJson(req);
  const check = await checkAuthentication(req, guard.ctx.user, body as unknown as AuthenticationResponseJSON, challenge);
  if (!check.ok) return secondFactorFailed(guard.ctx, "passkey", check.reason, { code: "passkey_failed", field: null });
  return completeSecondFactor(guard.ctx, "passkey");
});
