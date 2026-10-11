import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/password/policy";
import { parsePhone } from "@/lib/validation";
import { getDictionary } from "@/server/dictionary";
import { api, clientIp, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { RESET_LINK_EXPIRED, checkNewPassword, resetLinkUser } from "@/server/password-reset";
import { rateLimit } from "@/server/rate-limit";
import { getAuth } from "@/server/session";

/**
 * Live checklist for the sign-up, reset-password and change-password forms. The dictionary lives on the
 * server, so the browser asks here. For a reset, the account's details come from the token.
 */
export const POST = api(async (req) => {
  const limit = await rateLimit(`password-check:${clientIp(req)}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
  // Changing your own password while signed in: checked against your own details.
  if (body.self === true) {
    const auth = await getAuth();
    if (!auth || auth.session.stage !== "full") return jsonError(401, "Please sign in again.", { next: "/login" });
    return NextResponse.json({ rules: checkNewPassword(str(body.password), auth.user) });
  }
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
