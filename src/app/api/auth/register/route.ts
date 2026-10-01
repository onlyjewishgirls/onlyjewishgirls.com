import { randomBytes } from "node:crypto";
import parseMax from "libphonenumber-js/max";
import { NextResponse } from "next/server";
import { checkPassword, passwordIsValid } from "@/lib/password/policy";
import { isValidTimeZone } from "@/lib/streak/dates";
import {
  normalizeEmail,
  normalizeName,
  validateRegistration,
  type FieldErrors,
  type RegistrationInput,
} from "@/lib/validation";
import { getDictionary } from "@/server/dictionary";
import { api, clientIp, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { hashPassword } from "@/server/passwords";
import { rateLimit } from "@/server/rate-limit";
import { startSession } from "@/server/session";
import { createUser, emailTaken, usernameTaken } from "@/server/users";

export const POST = api(async (req) => {
  const limit = await rateLimit(`register:${clientIp(req)}`, 10, 60 * 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
  const input: RegistrationInput = {
    firstName: str(body.firstName),
    middleName: str(body.middleName),
    noMiddleName: body.noMiddleName === true,
    lastName: str(body.lastName),
    email: str(body.email),
    username: str(body.username).trim(),
    phoneCountry: str(body.phoneCountry) || "US",
    phone: str(body.phone),
    password: str(body.password),
    confirmPassword: str(body.confirmPassword),
    timeZone: str(body.timeZone),
  };

  const errors: FieldErrors = validateRegistration(input);
  const email = normalizeEmail(input.email);

  const phone = parseMax(input.phone.trim(), input.phoneCountry as Parameters<typeof parseMax>[1]);
  if (!errors.phone && phone?.getType() === "FIXED_LINE") errors.phone = "That looks like a landline. Enter a mobile number.";

  if (!errors.username && (await usernameTaken(input.username))) errors.username = "That username is taken";
  if (!errors.email && (await emailTaken(email))) errors.email = "An account with this email already exists";

  const rules = checkPassword(
    input.password,
    { ...input, email, phone: phone?.number },
    { dictionary: getDictionary() },
  );
  if (!errors.password && !passwordIsValid(rules)) errors.password = "Password doesn't meet every requirement";

  if (Object.keys(errors).length > 0 || !phone) {
    return jsonError(400, "Please fix the highlighted fields.", { fields: errors, passwordRules: rules });
  }

  const now = Date.now();
  let userId: number;
  try {
    userId = await createUser(
      {
        firstName: normalizeName(input.firstName),
        middleName: input.noMiddleName ? null : normalizeName(input.middleName),
        lastName: normalizeName(input.lastName),
        email,
        username: input.username,
        phone: phone.number,
        passwordHash: await hashPassword(input.password),
        timeZone: isValidTimeZone(input.timeZone) ? input.timeZone : "UTC",
        webauthnUserId: randomBytes(32).toString("base64url"),
      },
      now,
    );
  } catch (error) {
    // Two sign-ups racing for the same username/email.
    if (/UNIQUE constraint failed/.test(String((error as Error)?.message))) {
      return jsonError(409, "That username or email was just taken. Try another.");
    }
    throw error;
  }

  await startSession(userId, "password", now);
  return NextResponse.json({ next: "/setup-mfa" });
});
