import { NextResponse } from "next/server";
import { passwordIsValid } from "@/lib/password/policy";
import { logEvent } from "@/server/events";
import { api, jsonError, readJson, str, tooManyRequests } from "@/server/http";
import { mfaState, nextStep } from "@/server/mfa";
import { hashPassword, verifyPassword } from "@/server/passwords";
import { checkNewPassword, sendPasswordChangedEmail } from "@/server/password-reset";
import { rateLimit } from "@/server/rate-limit";
import { getAuth } from "@/server/session";
import { changePassword, findUserById } from "@/server/users";

/**
 * Choosing a new password while signed in. Needed after an admin sets a
 * temporary password, and available to anyone from their home page.
 */
export const POST = api(async (req) => {
  const ctx = await getAuth();
  if (!ctx || ctx.session.stage !== "full") return jsonError(401, "Please sign in again.", { next: "/login" });
  const { user } = ctx;
  const mfa = await mfaState(user);
  if (!mfa.complete) return jsonError(403, "Finish setting up two-step sign-in first.", { next: "/setup-mfa" });

  const limit = await rateLimit(`change-password:${user.id}`, 10, 15 * 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJson(req);
  const password = str(body.password);
  // A forced change follows a fresh sign-in with the temporary password, so it isn't asked for again.
  if (!user.mustChangePassword && !(await verifyPassword(str(body.currentPassword), user.passwordHash))) {
    return jsonError(400, "Your current password isn't right.", { fields: { currentPassword: "Incorrect password" } });
  }
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

  await changePassword(user.id, await hashPassword(password), ctx.session.idHash);
  await logEvent("password.changed", { user, detail: { forced: user.mustChangePassword } });
  sendPasswordChangedEmail(req, user, { keptThisDevice: true });
  const updated = (await findUserById(user.id))!;
  return NextResponse.json({ next: nextStep("full", mfa, updated.mustChangePassword) });
});
