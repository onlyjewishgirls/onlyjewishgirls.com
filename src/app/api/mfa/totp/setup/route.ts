import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { encrypt } from "@/server/crypto";
import { APP_NAME } from "@/server/env";
import { api, jsonError } from "@/server/http";
import { requireEnrollment } from "@/server/mfa-routes";
import { generateTotpSecret, totpUri } from "@/server/totp";
import { setPendingTotpSecret } from "@/server/users";

/** Creates a new authenticator-app secret. It only takes effect once the user proves it works. */
export const POST = api(async () => {
  const guard = await requireEnrollment();
  if (!guard.ok) return guard.response;
  if (guard.mfa.totp) return jsonError(409, "An authenticator app is already set up.");

  const { user } = guard.ctx;
  const secret = generateTotpSecret();
  await setPendingTotpSecret(user.id, encrypt(secret));
  const uri = totpUri(secret, user.username, APP_NAME);
  // Rendered here so the secret never goes to a third-party QR service.
  const qrCode = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return NextResponse.json({ uri, qrCode, secret: secret.match(/.{1,4}/g)!.join(" ") });
});
