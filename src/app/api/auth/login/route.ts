import { NextResponse } from "next/server";
import { isAdminRole } from "@/lib/admin/permissions";
import { isValidTimeZone } from "@/lib/streak/dates";
import { isUnblockableIp } from "@/lib/security";
import { looksLikeLoginName } from "@/lib/validation";
import { sha256 } from "@/server/crypto";
import { logEvent } from "@/server/events";
import { api, clientIp, fail, readJson, str, tooManyRequests } from "@/server/http";
import { isAllowlisted } from "@/server/ip-rules";
import { LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS, loginAccountKey, untilText } from "@/server/login-rules";
import { mfaState, nextStep } from "@/server/mfa";
import { burnPasswordCheck, verifyPassword } from "@/server/passwords";
import { isRateLimited, rateLimit, resetRateLimit } from "@/server/rate-limit";
import { startSession } from "@/server/session";
import { getSettings } from "@/server/settings";
import { recordStrike, strikeCounts } from "@/server/threat";
import { first } from "@/server/db";
import { findUserByLogin, updateTimeZone } from "@/server/users";

/**
 * Sign-in, step 1: identifier + password together. Every refusal says exactly
 * what is wrong (PORTAL-STANDARD §2 — this replaced the old "Incorrect
 * username/email or password" policy at the owner's request). Rate limits,
 * lockouts and auto-blacklisting still apply; they are stated, not hidden.
 */
export const POST = api(async (req) => {
  const body = await readJson(req);
  const typedIdentifier = str(body.identifier).trim();
  const identifier = typedIdentifier.toLowerCase();
  const password = str(body.password);
  if (!identifier) return fail(400, "validation", "Enter your username or email.", "identifier");
  if (!password) return fail(400, "validation", "Enter your password.", "password");
  const ip = clientIp(req);
  const timeZone = isValidTimeZone(str(body.timeZone)) ? str(body.timeZone) : null;

  const settings = await getSettings();
  if (settings.allowlist_mode === "everyone" && !(await isAllowlisted(ip))) {
    await logEvent("signin.ip_not_allowed", { detail: { mode: "everyone" } });
    return fail(403, "ip_not_allowed", `Your IP ${ip} is not on this portal's allowlist.`);
  }

  const ipLimit = await rateLimit(`login:ip:${ip}`, 30, LOGIN_WINDOW_MS);
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfterSeconds, ip, "sign-in attempts");

  const user = await findUserByLogin(identifier);
  // What was typed is only recorded if it could be a username or email, never if it might be a password.
  const typed = user || !looksLikeLoginName(typedIdentifier) ? undefined : { identifier: identifier.slice(0, 64) };

  if (!user) {
    await burnPasswordCheck(password);
    await logEvent("signin.unknown", { detail: typed });
    // Unknown names are hashed so what was typed isn't kept in the strike table.
    await recordStrike("failed_password", { ip, subject: `name:${sha256(identifier).slice(0, 16)}` });
    return fail(401, "no_account", `No account exists with the username or email "${typedIdentifier.slice(0, 80)}".`, "identifier");
  }

  const tz = timeZone ?? user.timeZone;
  const now = Date.now();
  if (user.suspendedAt !== null) {
    await logEvent("signin.suspended", { user });
    return fail(
      403,
      "account_suspended",
      `This account is suspended by an administrator.${user.suspendedReason ? ` Reason: ${user.suspendedReason}` : ""}`,
    );
  }
  if (user.lockedUntil !== null && user.lockedUntil > now) {
    await logEvent("signin.locked", { user });
    const until = user.lockedUntil >= 8.64e15 ? "until an administrator unlocks it" : `until ${untilText(user.lockedUntil, tz, now)}`;
    return fail(
      403,
      "account_locked",
      `This account is locked by an administrator ${until}.${user.lockedReason ? ` Reason: ${user.lockedReason}` : ""}`,
    );
  }

  // Keyed by account, so switching between username and email doesn't buy extra guesses.
  const accountKey = loginAccountKey(user.id);
  const locked = await isRateLimited(accountKey, LOGIN_ATTEMPTS_PER_WINDOW, now);
  if (locked.limited) {
    return fail(
      429,
      "account_locked",
      `This account is locked until ${untilText(now + locked.retryAfterSeconds * 1000, tz, now)} after ${LOGIN_ATTEMPTS_PER_WINDOW} wrong passwords.`,
      null,
      { retryAfterSeconds: locked.retryAfterSeconds },
    );
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const attempt = await rateLimit(accountKey, LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS, now);
    await logEvent("signin.failed", { user });
    const blocked = await recordStrike("failed_password", { ip, subject: `u${user.id}` });
    if (blocked) {
      return fail(403, "ip_blocked", `Incorrect password for ${user.username}. Your IP ${ip} is now blocked (reason: ${blocked.reason}).`, "password");
    }
    const state = await isRateLimited(accountKey, LOGIN_ATTEMPTS_PER_WINDOW, now);
    if (state.limited || !attempt.ok) {
      await logEvent("signin.rate_limited", { user });
      return fail(
        401,
        "wrong_password",
        `Incorrect password for ${user.username}. The account is now locked until ${untilText(now + state.retryAfterSeconds * 1000, tz, now)} after ${LOGIN_ATTEMPTS_PER_WINDOW} wrong passwords.`,
        "password",
      );
    }
    const used = await usedAttempts(accountKey);
    const left = LOGIN_ATTEMPTS_PER_WINDOW - used;
    // The IP threshold (§7) can come first; say which.
    let ipNote = "";
    if (settings.auto_block_enabled && !isUnblockableIp(ip)) {
      const counts = await strikeCounts(ip, now - settings.auto_block_window_minutes * 60_000);
      const ipLeft = settings.auto_block_failed_passwords - counts.failed_password;
      if (ipLeft < left) ipNote = ` ${ipLeft} more wrong password${ipLeft === 1 ? "" : "s"} from IP ${ip} will block that address.`;
    }
    return fail(
      401,
      "wrong_password",
      `Incorrect password for ${user.username}. ${left} attempt${left === 1 ? "" : "s"} left before the account locks.${ipNote}`,
      "password",
      { attemptsLeft: left },
    );
  }

  if (settings.allowlist_mode === "admins" && isAdminRole(user.role) && !(await isAllowlisted(ip))) {
    await logEvent("signin.ip_not_allowed", { user, detail: { mode: "admins" } });
    return fail(403, "ip_not_allowed", `Your IP ${ip} is not on this portal's allowlist, which admin accounts must sign in from.`);
  }

  await resetRateLimit(accountKey);
  if (timeZone && timeZone !== user.timeZone) await updateTimeZone(user.id, timeZone);

  await startSession(user.id, "password");
  await logEvent("signin.password", { user });
  const next = nextStep("password", await mfaState(user));
  return NextResponse.json({
    ok: true,
    next,
    ...(user.mustChangePassword
      ? {
          code: "must_change_password",
          notice: "Your password was set by an administrator. After two-step verification you'll be asked to choose your own.",
        }
      : {}),
  });
});

async function usedAttempts(key: string): Promise<number> {
  const row = await first<{ count: number; reset_at: number }>("SELECT count, reset_at FROM rate_limits WHERE key = ?", key);
  return row && row.reset_at > Date.now() ? row.count : 0;
}
