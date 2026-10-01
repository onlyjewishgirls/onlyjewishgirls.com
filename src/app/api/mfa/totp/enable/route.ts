import { decrypt } from "@/server/crypto";
import { api, jsonError, readJson, str } from "@/server/http";
import { afterEnrollment, requireEnrollment } from "@/server/mfa-routes";
import { verifyTotp } from "@/server/totp";
import { enableTotp } from "@/server/users";

export const POST = api(async (req) => {
  const guard = await requireEnrollment();
  if (!guard.ok) return guard.response;
  const { user } = guard.ctx;
  if (guard.mfa.totp) return jsonError(409, "An authenticator app is already set up.");
  if (!user.totpPendingSecretEnc) return jsonError(400, "Start the authenticator setup again.");

  const code = str((await readJson(req)).code);
  const now = Date.now();
  const step = verifyTotp(decrypt(user.totpPendingSecretEnc), code, now, null);
  if (step === null) return jsonError(400, "That code didn't match. Check your phone's clock and try the newest code.");

  enableTotp(user.id, step, now);
  return afterEnrollment(guard.ctx);
});
