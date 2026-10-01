import { NextResponse } from "next/server";
import { api, jsonError } from "@/server/http";
import { requireSecondFactorStep } from "@/server/mfa-routes";
import { setChallenge } from "@/server/session";
import { authenticationOptions } from "@/server/webauthn";

export const POST = api(async () => {
  const guard = await requireSecondFactorStep();
  if (!guard.ok) return guard.response;
  if (guard.mfa.passkeys === 0) return jsonError(400, "You haven't added a passkey yet.");
  const options = await authenticationOptions(guard.ctx.user);
  setChallenge(guard.ctx.session, options.challenge);
  return NextResponse.json(options);
});
