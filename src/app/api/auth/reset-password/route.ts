import { NextResponse } from "next/server";
import { passwordIsValid } from "@/lib/password/policy";
import { api, clientIp, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { hashPassword, verifyPassword } from "@/server/passwords";
import {
  RESET_LINK_EXPIRED as EXPIRED,
  checkNewPassword,
  hashResetToken,
  sendPasswordChangedEmail,
} from "@/server/password-reset";
import { rateLimit, resetRateLimit } from "@/server/rate-limit";
import { claimPasswordReset, findPasswordResetUser, resetPassword } from "@/server/users";

export const POST = api(async (req) => {
  const limit = await rateLimit(`reset:ip:${clientIp(req)}`, 20, 60 * 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
  const tokenHash = hashResetToken(str(body.token));
  const password = str(body.password);
  const now = Date.now();
  const user = await findPasswordResetUser(tokenHash, now);
  if (!user) return jsonError(400, EXPIRED, { expired: true });

  if (password !== str(body.confirmPassword)) {
    return jsonError(400, "Passwords don't match.", { fields: { confirmPassword: "Passwords don't match" } });
  }
  const rules = checkNewPassword(password, user);
  if (!passwordIsValid(rules)) {
    return jsonError(400, "Password doesn't meet every requirement.", { passwordRules: rules });
  }
  if (await verifyPassword(password, user.passwordHash)) {
    return jsonError(400, "That's already your password. Choose a new one.", {
      fields: { password: "That's your current password" },
    });
  }

  const newHash = await hashPassword(password);
  if (!(await claimPasswordReset(tokenHash, user.id, now))) return jsonError(400, EXPIRED, { expired: true });
  await resetPassword(user.id, newHash);
  await resetRateLimit(`login:account:${user.id}`);
  sendPasswordChangedEmail(req, user);
  return NextResponse.json({ next: "/login?reset=1" });
});
