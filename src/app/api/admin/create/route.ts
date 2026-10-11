import { randomBytes } from "node:crypto";
import parseMax from "libphonenumber-js/max";
import { NextResponse } from "next/server";
import { canCreate, isRole } from "@/lib/admin/permissions";
import { isValidTimeZone } from "@/lib/streak/dates";
import { normalizeEmail, normalizeName, validateEmail, validateName, validatePhone, validateUsername } from "@/lib/validation";
import { recentlyVerified, requireAdminApi } from "@/server/admin";
import { logEvent } from "@/server/events";
import { api, jsonError, readJson, str } from "@/server/http";
import { hashPassword } from "@/server/passwords";
import { rateLimit } from "@/server/rate-limit";
import { generateTemporaryPassword } from "@/server/temp-password";
import { createUser, emailTaken, usernameTaken } from "@/server/users";

type Fields = Partial<Record<"firstName" | "middleName" | "lastName" | "email" | "username" | "phone", string>>;

/**
 * Creates an account with a temporary password, shown to the admin once.
 * At first sign-in the person sets up two-step sign-in and then picks their own password.
 */
export const POST = api(async (req) => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { ctx } = guard;
  const actor = ctx.user;

  const body = await readJson(req);
  const role = isRole(body.role) ? body.role : "member";
  if (!canCreate(actor, role)) return jsonError(403, "Only the owner can create admin accounts.");
  const now = Date.now();
  if (!recentlyVerified(ctx.session, now)) return jsonError(403, "Confirm it's you to make changes.", { verify: true });
  const limit = await rateLimit(`admin:${actor.id}`, 300, 60 * 60_000, now);
  if (!limit.ok) return jsonError(429, "That's a lot of changes at once. Wait a few minutes and try again.");

  const input = {
    firstName: str(body.firstName),
    middleName: str(body.middleName),
    lastName: str(body.lastName),
    email: str(body.email),
    username: str(body.username).trim(),
    phone: str(body.phone),
    phoneCountry: str(body.phoneCountry) || "US",
    timeZone: str(body.timeZone),
  };
  const fields: Fields = {};
  const set = (key: keyof Fields, error: string | undefined) => {
    if (error) fields[key] = error;
  };
  set("firstName", validateName(input.firstName, "First name"));
  if (input.middleName.trim()) set("middleName", validateName(input.middleName, "Middle name"));
  set("lastName", validateName(input.lastName, "Last name"));
  set("email", validateEmail(input.email));
  set("username", validateUsername(input.username));
  set("phone", validatePhone(input.phone, input.phoneCountry));
  const email = normalizeEmail(input.email);
  const phone = parseMax(input.phone.trim(), input.phoneCountry as Parameters<typeof parseMax>[1]);
  if (!fields.username && (await usernameTaken(input.username))) fields.username = "That username is taken";
  if (!fields.email && (await emailTaken(email))) fields.email = "An account with this email already exists";
  if (Object.keys(fields).length > 0 || !phone) return jsonError(400, "Please fix the highlighted fields.", { fields });

  const person = {
    firstName: normalizeName(input.firstName),
    middleName: input.middleName.trim() ? normalizeName(input.middleName) : null,
    lastName: normalizeName(input.lastName),
    email,
    username: input.username,
    phone: phone.number,
  };
  const temporaryPassword = generateTemporaryPassword({ ...person, middleName: person.middleName ?? "" });
  let userId: number;
  try {
    userId = await createUser(
      {
        ...person,
        passwordHash: await hashPassword(temporaryPassword),
        timeZone: isValidTimeZone(input.timeZone) ? input.timeZone : actor.timeZone,
        webauthnUserId: randomBytes(32).toString("base64url"),
      },
      now,
      { role, mustChangePassword: true },
    );
  } catch (error) {
    if (/UNIQUE constraint failed/.test(String((error as Error)?.message))) {
      return jsonError(409, "That username or email was just taken. Try another.");
    }
    throw error;
  }
  await logEvent("admin.create_account", { user: { id: userId, username: person.username }, actor, detail: { role }, now });
  return NextResponse.json({
    ok: true,
    userId,
    temporaryPassword,
    message: `Created ${person.username}. Give them this temporary password; they'll choose their own after signing in.`,
  });
});
