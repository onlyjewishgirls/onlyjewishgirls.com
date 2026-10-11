import { NextResponse } from "next/server";
import { requireAdminApi } from "@/server/admin";
import { factorPredates } from "@/server/admin-verify";
import { api, jsonError } from "@/server/http";
import { setChallenge } from "@/server/session";
import { listPasskeys } from "@/server/users";
import { authenticationOptions } from "@/server/webauthn";

/** Passkey prompt for re-verifying before admin changes. */
export const POST = api(async (req) => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const allow = factorPredates(guard.ctx.session);
  if (!(await listPasskeys(guard.ctx.user.id)).some((p) => allow(p.createdAt))) {
    return jsonError(400, "Use your authenticator app instead.");
  }
  const options = await authenticationOptions(req, guard.ctx.user, (p) => allow(p.createdAt));
  await setChallenge(guard.ctx.session, options.challenge);
  return NextResponse.json(options);
});
