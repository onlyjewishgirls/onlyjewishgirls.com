import { decrypt } from "@/server/crypto";
import { api, fail, readJson, str } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";
import { explainTotpFailure, verifyTotp } from "@/server/totp";
import { claimTotpStep } from "@/server/users";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;
  if (!guard.mfa.totp || !user.totpSecretEnc) {
    return fail(400, "mfa_not_enrolled", "This account has no authenticator app connected. Use your passkey or a recovery code.");
  }

  const code = str((await readJson(req)).code);
  const now = Date.now();
  const secret = decrypt(user.totpSecretEnc);
  const step = verifyTotp(secret, code, now, user.totpLastStep);
  // claimTotpStep is atomic, so the same code can't be used twice even in parallel requests.
  if (step === null || !(await claimTotpStep(user.id, step))) {
    const why = step === null ? explainTotpFailure(secret, code, now, user.totpLastStep) : "That code was already used. Wait for the next one.";
    return secondFactorFailed(guard.ctx, "totp", why);
  }
  return completeSecondFactor(guard.ctx, "totp");
});
