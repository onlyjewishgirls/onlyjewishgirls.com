import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { api, jsonError, readJson } from "@/server/http";
import { afterEnrollment, requireEnrollment } from "@/server/mfa-routes";
import { takeChallenge } from "@/server/session";
import { verifyRegistration } from "@/server/webauthn";

export const POST = api(async (req) => {
  const guard = await requireEnrollment();
  if (!guard.ok) return guard.response;
  const challenge = await takeChallenge(guard.ctx.session);
  if (!challenge) return jsonError(400, "That took too long. Please try again.");

  const body = await readJson(req);
  let verified = false;
  try {
    verified = await verifyRegistration(req, guard.ctx.user, body as unknown as RegistrationResponseJSON, challenge);
  } catch (error) {
    console.warn("Passkey registration rejected:", (error as Error).message);
  }
  if (!verified) return jsonError(400, "We couldn't verify that passkey. Please try again.");
  return afterEnrollment(guard.ctx);
});
