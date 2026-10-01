import { decrypt } from "@/server/crypto";
import { api, jsonError, readJson, str } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";
import { verifyTotp } from "@/server/totp";
import { claimTotpStep } from "@/server/users";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;
  if (!guard.mfa.totp || !user.totpSecretEnc) return jsonError(400, "You haven't set up an authenticator app.");

  const code = str((await readJson(req)).code);
  const step = verifyTotp(decrypt(user.totpSecretEnc), code, Date.now(), user.totpLastStep);
  // claimTotpStep is atomic, so the same code can't be used twice even in parallel requests.
  if (step === null || !claimTotpStep(user.id, step)) {
    return secondFactorFailed(guard.ctx, "That code didn't work. Wait for a new one and try again.");
  }
  return completeSecondFactor(guard.ctx);
});
