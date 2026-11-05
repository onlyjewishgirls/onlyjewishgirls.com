import { checkEmailCode, emailOtpAvailability } from "@/server/email-otp";
import { api, fail, readJson, str } from "@/server/http";
import { completeSecondFactor, requireSecondFactorStep, secondFactorFailed } from "@/server/mfa-routes";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  const available = await emailOtpAvailability(guard.ctx.user);
  if (!available.ok || !guard.mfa.email) {
    return fail(400, "mfa_not_enrolled", available.ok ? "Email codes aren't set up for this account yet." : available.reason);
  }
  const check = await checkEmailCode(guard.ctx.user, str((await readJson(req)).code));
  if (!check.ok) return secondFactorFailed(guard.ctx, "email", check.reason);
  return completeSecondFactor(guard.ctx, "email");
});
