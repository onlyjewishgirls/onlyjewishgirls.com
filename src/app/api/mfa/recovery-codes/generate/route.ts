import { NextResponse } from "next/server";
import { randomCode, sha256 } from "@/server/crypto";
import { api, jsonError } from "@/server/http";
import { getAuth } from "@/server/session";
import { mfaState } from "@/server/mfa";
import { replaceRecoveryCodes } from "@/server/users";
import { normalizeRecoveryCode } from "@/lib/recovery-codes";

const CODE_COUNT = 10;

/** Issues a fresh set of one-time backup codes (replacing any old ones). Shown to the user once. */
export const POST = api(async () => {
  const ctx = await getAuth();
  if (!ctx || ctx.session.stage !== "full") return jsonError(401, "Please sign in again.", { next: "/login" });
  const mfa = await mfaState(ctx.user);
  if (mfa.passkeys === 0 || !mfa.totp) return jsonError(400, "Set up a passkey and an authenticator app first.");

  const codes = Array.from({ length: CODE_COUNT }, () => {
    const raw = randomCode(10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await replaceRecoveryCodes(ctx.user.id, codes.map((c) => sha256(normalizeRecoveryCode(c))), Date.now());
  return NextResponse.json({ codes, next: "/home" });
});
