import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { api, jsonError, readJson } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";
import { takeChallenge } from "@/server/session";
import { verifyAuthentication } from "@/server/webauthn";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  const challenge = takeChallenge(guard.ctx.session);
  if (!challenge) return jsonError(400, "That took too long. Please try again.");

  const body = await readJson(req);
  let verified = false;
  try {
    verified = await verifyAuthentication(guard.ctx.user, body as unknown as AuthenticationResponseJSON, challenge);
  } catch (error) {
    console.warn("Passkey sign-in rejected:", (error as Error).message);
  }
  if (!verified) return secondFactorFailed(guard.ctx, "That passkey didn't work. Try again or use another method.");
  return completeSecondFactor(guard.ctx);
});
