import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/password/policy";
import { parsePhone } from "@/lib/validation";
import { getDictionary } from "@/server/dictionary";
import { api, clientIp, readJson, str, tooManyRequests } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

/** Live checklist for the sign-up form. The dictionary lives on the server, so the browser asks here. */
export const POST = api(async (req) => {
  const limit = await rateLimit(`password-check:${clientIp(req)}`, 120, 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
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
