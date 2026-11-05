import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { NextResponse } from "next/server";
import { isAdminRole } from "@/lib/admin/permissions";
import { first } from "@/server/db";
import { logEvent } from "@/server/events";
import { api, clientIp, fail, readJson } from "@/server/http";
import { isAllowlisted } from "@/server/ip-rules";
import { mfaState, nextStep } from "@/server/mfa";
import { startSession } from "@/server/session";
import { getSettings } from "@/server/settings";
import { recordStrike } from "@/server/threat";
import { findPasskeyById, findUserById, setLastLogin } from "@/server/users";
import { checkWithPasskey } from "@/server/webauthn";

function challengeOf(response: AuthenticationResponseJSON): string | null {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
    return typeof data.challenge === "string" ? data.challenge : null;
  } catch {
    return null;
  }
}

/**
 * Usernameless passkey sign-in. A passkey with user verification is both
 * factors at once, so this signs in fully. The same account rules as the
 * password form apply, and every refusal is stated exactly (§2 passkey_failed).
 */
export const POST = api(async (req) => {
  const ip = clientIp(req);
  const response = (await readJson(req)) as unknown as AuthenticationResponseJSON;
  if (!response || typeof response.id !== "string" || !response.response?.clientDataJSON) {
    return fail(400, "passkey_failed", "The browser didn't send a passkey response.");
  }
  const challenge = challengeOf(response);
  const claimed = challenge
    ? await first<{ challenge: string }>(
        "DELETE FROM webauthn_challenges WHERE challenge = ? AND expires_at > ? RETURNING challenge",
        challenge,
        Date.now(),
      )
    : null;
  if (!claimed) return fail(400, "passkey_failed", "The passkey request expired or was already used. Try again.");

  const passkey = await findPasskeyById(response.id);
  if (!passkey) {
    await recordStrike("failed_mfa", { ip, subject: "passkey:unknown" });
    return fail(401, "passkey_failed", "That passkey is not registered on any account here. Sign in with your password instead.");
  }
  const user = await findUserById(passkey.userId);
  if (!user) return fail(401, "passkey_failed", "That passkey's account no longer exists.");
  if (user.suspendedAt !== null) {
    await logEvent("signin.suspended", { user });
    return fail(403, "account_suspended", `This account is suspended by an administrator.${user.suspendedReason ? ` Reason: ${user.suspendedReason}` : ""}`);
  }
  if (user.lockedUntil !== null && user.lockedUntil > Date.now()) {
    await logEvent("signin.locked", { user });
    return fail(403, "account_locked", `This account is locked by an administrator.${user.lockedReason ? ` Reason: ${user.lockedReason}` : ""}`);
  }
  const settings = await getSettings();
  if (
    (settings.allowlist_mode === "everyone" || (settings.allowlist_mode === "admins" && isAdminRole(user.role))) &&
    !(await isAllowlisted(ip))
  ) {
    await logEvent("signin.ip_not_allowed", { user });
    return fail(403, "ip_not_allowed", `Your IP ${ip} is not on this portal's allowlist.`);
  }

  const check = await checkWithPasskey(req, passkey, response, claimed.challenge);
  if (!check.ok) {
    await logEvent("signin.mfa_failed", { user, detail: { method: "passkey" } });
    await recordStrike("failed_mfa", { ip, subject: `u${user.id}` });
    return fail(401, "passkey_failed", check.reason);
  }
  const now = Date.now();
  await startSession(user.id, "full", now);
  await setLastLogin(user.id, now);
  await logEvent("signin.complete", { user, detail: { method: "passkey_usernameless" }, now });
  return NextResponse.json({ ok: true, next: nextStep("full", await mfaState(user), user.mustChangePassword) });
});
