import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/password/policy";
import { parsePhone } from "@/lib/validation";
import { getDictionary } from "@/server/dictionary";
import { api, clientIp, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { RESET_LINK_EXPIRED, checkNewPassword, resetLinkUser } from "@/server/password-reset";
import { rateLimit } from "@/server/rate-limit";

/**
 * Live checklist for the sign-up and reset-password forms. The dictionary lives on the
 * server, so the browser asks here. For a reset, the account's details come from the token.
 */
export const POST = api(async (req) => {
  const limit = await rateLimit(`password-check:${clientIp(req)}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
  if ("resetToken" in body) {
    const user = await resetLinkUser(body.resetToken);
    if (!user) return jsonError(400, RESET_LINK_EXPIRED, { expired: true });
    return NextResponse.json({ rules: checkNewPassword(str(body.password), user) });
  }

  const rules = checkPassword(
    str(body.password),
    {
      firstName: str(body.firstName),
      middleName: str(body.middleName),
      lastName: str(body.lastName),
      username: str(body.username),
      email: str(body.email),
      phone: parsePhone(str(body.phone), str(body.phoneCountry) || "US")?.number,
    },
    { dictionary: getDictionary() },
  );
  return NextResponse.json({ rules });
});
