import { normalizeRecoveryCode } from "@/lib/recovery-codes";
import { sha256 } from "@/server/crypto";
import { first } from "@/server/db";
import { api, readJson, str } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";
import { consumeRecoveryCode } from "@/server/users";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;

  const code = normalizeRecoveryCode(str((await readJson(req)).code));
  const hash = code ? sha256(code) : null;
  const remaining = hash ? await consumeRecoveryCode(guard.ctx.user.id, hash, Date.now()) : null;
  if (remaining === null) {
    const used = hash
      ? await first("SELECT 1 FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NOT NULL", guard.ctx.user.id, hash)
      : null;
    const why = !code
      ? "That isn't a recovery code. They look like XXXXX-XXXXX."
      : used
        ? "That recovery code was already used. Each one works once."
        : "That recovery code is incorrect.";
    return secondFactorFailed(guard.ctx, "recovery_code", why);
  }
  return completeSecondFactor(guard.ctx, "recovery_code", { remainingRecoveryCodes: remaining });
});
