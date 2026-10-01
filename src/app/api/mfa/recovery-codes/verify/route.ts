import { normalizeRecoveryCode } from "@/lib/recovery-codes";
import { sha256 } from "@/server/crypto";
import { api, readJson, str } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";
import { consumeRecoveryCode } from "@/server/users";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;

  const code = normalizeRecoveryCode(str((await readJson(req)).code));
  const remaining = code ? consumeRecoveryCode(guard.ctx.user.id, sha256(code), Date.now()) : null;
  if (remaining === null) return secondFactorFailed(guard.ctx, "That recovery code isn't valid or was already used.");
  return completeSecondFactor(guard.ctx, { remainingRecoveryCodes: remaining });
});
