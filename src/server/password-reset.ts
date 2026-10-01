import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { NextRequest } from "next/server";
import { checkPassword } from "@/lib/password/policy";
import { randomToken, sha256 } from "./crypto";
import { getDictionary } from "./dictionary";
import { APP_NAME, cfEnv, isLocalHost } from "./env";
import { sendEmail, simpleHtml } from "./mailer";
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

/** Runs after the response is sent, so timing doesn't reveal whether the account exists. */
function inBackground(task: Promise<unknown>) {
  try {
    getCloudflareContext().ctx.waitUntil(task);
  } catch {
    void task;
  }
}

export async function sendPasswordResetEmail(req: NextRequest, user: User, now = Date.now()) {
  const token = randomToken();
  await createPasswordReset(user.id, hashResetToken(token), now, now + RESET_LINK_MINUTES * 60_000);
  const url = `${siteOrigin(req)}/reset-password?token=${token}`;
  const lines = [
    `Hi ${user.firstName},`,
    `Someone (hopefully you) asked to reset the password for ${APP_NAME} account "${user.username}". This link works once and expires in ${RESET_LINK_MINUTES} minutes.`,
    "If you didn't ask for this, ignore this email. Your password won't change, and nobody can sign in without your passkey or authenticator app.",
  ];
  inBackground(
    sendEmail(
      {
        to: user.email,
        subject: `Reset your ${APP_NAME} password`,
        text: `${lines[0]}\n\n${lines[1]}\n\n${url}\n\n${lines[2]}\n`,
        html: simpleHtml(lines, { label: "Choose a new password", url }),
      },
      { local: isLocalHost(new URL(req.url).host) },
    ),
  );
}

export function sendPasswordChangedEmail(req: NextRequest, user: User) {
  const url = `${siteOrigin(req)}/forgot-password`;
  const lines = [
    `Hi ${user.firstName},`,
    `The password for your ${APP_NAME} account "${user.username}" was just changed, and you were signed out on every device.`,
    "If this wasn't you, reset your password right away and make sure your email account is secure.",
  ];
  inBackground(
    sendEmail(
      {
        to: user.email,
        subject: `Your ${APP_NAME} password was changed`,
        text: `${lines.join("\n\n")}\n\n${url}\n`,
        html: simpleHtml(lines, { label: "Reset my password", url }),
      },
      { local: isLocalHost(new URL(req.url).host) },
    ),
  );
}
