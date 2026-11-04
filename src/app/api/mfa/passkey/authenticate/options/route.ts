import { NextResponse } from "next/server";
import { api, fail } from "@/server/http";
import { requireSecondFactorStep } from "@/server/mfa-routes";
import { setChallenge } from "@/server/session";
import { authenticationOptions } from "@/server/webauthn";

export const POST = api(async (req) => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  if (guard.mfa.passkeys === 0) return fail(400, "passkey_failed", "This account has no passkey registered. Use your authenticator app or a recovery code.");
  const options = await authenticationOptions(req, guard.ctx.user);
  await setChallenge(guard.ctx.session, options.challenge);
  return NextResponse.json(options);
});
