import { NextResponse } from "next/server";
import { maskEmail } from "@/lib/security";
import { sendEmailCode, EMAIL_CODE_MINUTES } from "@/server/email-otp";
import { logEvent } from "@/server/events";
import { api, fail } from "@/server/http";
import { requireSecondFactorStep } from "@/server/mfa-routes";

/** Emails a 6-digit sign-in code (second step of signing in). */
export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  const result = await sendEmailCode(req, guard.ctx.user);
  if (!result.ok) return fail(result.code === "rate_limited" ? 429 : result.code === "delivery_failed" ? 502 : 400, result.code, result.error);
  await logEvent("mfa.email_code_sent", { user: guard.ctx.user });
  return NextResponse.json({
    ok: true,
    message: `We emailed a 6-digit code to ${maskEmail(result.to)}. It expires in ${EMAIL_CODE_MINUTES} minutes.`,
  });
});
