import "server-only";
import type { NextRequest } from "next/server";
import { checkPassword } from "@/lib/password/policy";
import { randomToken, sha256 } from "./crypto";
import { getDictionary } from "./dictionary";
import { composePasswordChangedEmail, composeResetEmail, requestFacts } from "./account-mail";
import { cfEnv, inBackground, isLocalHost } from "./env";
import { sendEmail, siteIdentity } from "./mailer";
import { createPasswordReset, findPasswordResetUser, type User } from "./users";

export const RESET_LINK_MINUTES = 30;

export const RESET_LINK_EXPIRED = "This reset link has expired or was already used. Request a new one.";

export const hashResetToken = (token: string) => sha256(`password-reset:${token}`);

/** The account a reset link belongs to, while the link is unused and unexpired. */
export async function resetLinkUser(token: unknown, now = Date.now()): Promise<User | null> {
  return typeof token === "string" && token ? findPasswordResetUser(hashResetToken(token), now) : null;
}

/** Every password rule, including the dictionary and the account's own name, username, email and phone. */
export function checkNewPassword(password: string, user: User) {
  return checkPassword(
    password,
    {
      firstName: user.firstName,
      middleName: user.middleName ?? "",
      lastName: user.lastName,
      username: user.username,
      email: user.email,
      phone: user.phone,
    },
    { dictionary: getDictionary() },
  );
}

function siteOrigin(req: NextRequest): string {
  return (cfEnv().PUBLIC_ORIGIN ?? new URL(req.url).origin).replace(/\/$/, "");
}


/**
 * Emails a reset link. `byAdmin`: an administrator sent it from the console or the admin panel, so the
 * email says so instead of "You asked to reset…".
 */
export async function sendPasswordResetEmail(req: NextRequest, user: User, now = Date.now(), { byAdmin = false } = {}) {
  const token = randomToken();
  await createPasswordReset(user.id, hashResetToken(token), now, now + RESET_LINK_MINUTES * 60_000);
  const url = `${siteOrigin(req)}/reset-password?token=${token}`;
  const mail = composeResetEmail(siteIdentity(), {
    firstName: user.firstName,
    username: user.username,
    url,
    minutes: RESET_LINK_MINUTES,
    byAdmin,
    facts: await requestFacts(now),
  });
  inBackground(sendEmail({ to: user.email, ...mail }, { local: isLocalHost(new URL(req.url).host) }));
}

export function sendPasswordChangedEmail(req: NextRequest, user: User, { keptThisDevice = false } = {}) {
  inBackground(
    (async () => {
      const mail = composePasswordChangedEmail(siteIdentity(), {
        firstName: user.firstName,
        username: user.username,
        keptThisDevice,
        facts: await requestFacts(),
      });
      return sendEmail({ to: user.email, ...mail }, { local: isLocalHost(new URL(req.url).host) });
    })(),
  );
}
