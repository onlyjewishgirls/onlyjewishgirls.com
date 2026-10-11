import { NextResponse } from "next/server";
import { requireAdminApi } from "@/server/admin";
import { api, jsonError } from "@/server/http";
import { setChallenge } from "@/server/session";
import { listPasskeys } from "@/server/users";
import { authenticationOptions } from "@/server/webauthn";

/** Passkey prompt for re-verifying before admin changes. */
export const POST = api(async (req) => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  if ((await listPasskeys(guard.ctx.user.id)).length === 0) return jsonError(400, "You don't have a passkey.");
  const options = await authenticationOptions(req, guard.ctx.user);
  await setChallenge(guard.ctx.session, options.challenge);
  return NextResponse.json(options);
});
