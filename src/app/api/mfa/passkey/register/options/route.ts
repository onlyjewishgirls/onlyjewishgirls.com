import { NextResponse } from "next/server";
import { api } from "@/server/http";
import { requireEnrollment } from "@/server/mfa-routes";
import { setChallenge } from "@/server/session";
import { registrationOptions } from "@/server/webauthn";

export const POST = api(async (req) => {
  const guard = await requireEnrollment();
  if (!guard.ok) return guard.response;
  const options = await registrationOptions(req, guard.ctx.user);
  await setChallenge(guard.ctx.session, options.challenge);
  return NextResponse.json(options);
});
