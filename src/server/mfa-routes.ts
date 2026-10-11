import "server-only";
import { NextResponse } from "next/server";
import { jsonError, tooManyRequests } from "./http";
import { canEnroll, mfaState, nextStep, type MfaState } from "./mfa";
import { isRateLimited, rateLimit } from "./rate-limit";
import { logEvent } from "./events";
import { getAuth, recordMfaFailure, startSession, type AuthContext } from "./session";
import { findUserById, setLastLogin } from "./users";

/** How a sign-in's second step was completed. */
export type SecondFactor = "passkey" | "totp" | "recovery_code" | "first_setup";

/**
 * Wrong second-factor attempts allowed per account per hour, across all
 * sessions — so signing in again with a stolen password doesn't reset the count.
 */
export const MFA_FAILURES_PER_HOUR = 10;
export const mfaFailureKey = (userId: number) => `mfa-failures:${userId}`;

type Guarded = { ok: true; ctx: AuthContext; mfa: MfaState } | { ok: false; response: Response };

const SIGN_IN_AGAIN = "Your sign-in expired. Please sign in again.";

/** For adding a passkey or authenticator app. */
export async function requireEnrollment(): Promise<Guarded> {
  const ctx = await getAuth();
  if (!ctx) return { ok: false, response: jsonError(401, SIGN_IN_AGAIN, { next: "/login" }) };
  const mfa = await mfaState(ctx.user);
  if (!canEnroll(ctx.session.stage, mfa)) {
    return { ok: false, response: jsonError(403, "Verify your identity first.", { next: "/login/verify" }) };
  }
  return { ok: true, ctx, mfa };
}

/** For the second step of signing in. */
export async function requireSecondFactorStep(): Promise<Guarded> {
  const ctx = await getAuth();
  if (!ctx) return { ok: false, response: jsonError(401, SIGN_IN_AGAIN, { next: "/login" }) };
  const mfa = await mfaState(ctx.user);
  if (ctx.session.stage !== "password" || mfa.factors === 0) {
    return { ok: false, response: jsonError(400, "Nothing to verify.", { next: nextStep(ctx.session.stage, mfa) }) };
  }
  const limit = await isRateLimited(mfaFailureKey(ctx.user.id), MFA_FAILURES_PER_HOUR);
  if (limit.limited) return { ok: false, response: tooManyRequests(limit.retryAfterSeconds) };
  return { ok: true, ctx, mfa };
}

async function nextAfterFullSignIn(userId: number) {
  const user = (await findUserById(userId))!;
  return nextStep("full", await mfaState(user), user.mustChangePassword);
}

/** Upgrades to a fully signed-in session and tells the browser where to go next. */
export async function completeSecondFactor(ctx: AuthContext, method: SecondFactor, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  await startSession(ctx.user.id, "full", now);
  await setLastLogin(ctx.user.id, now);
  await logEvent("signin.complete", { user: ctx.user, detail: { method }, now });
  return NextResponse.json({ next: await nextAfterFullSignIn(ctx.user.id), ...extra });
}

/** After enrolling a factor: if this was the first one, the session is now fully signed in. */
export async function afterEnrollment(ctx: AuthContext, extra: Record<string, unknown> = {}) {
  if (ctx.session.stage === "password") return completeSecondFactor(ctx, "first_setup", extra);
  return NextResponse.json({ next: await nextAfterFullSignIn(ctx.user.id), ...extra });
}

export async function secondFactorFailed(ctx: AuthContext, method: SecondFactor, message: string) {
  await rateLimit(mfaFailureKey(ctx.user.id), MFA_FAILURES_PER_HOUR, 60 * 60_000);
  await logEvent("signin.mfa_failed", { user: ctx.user, detail: { method } });
  if (await recordMfaFailure(ctx.session)) {
    await logEvent("signin.mfa_locked", { user: ctx.user, detail: { method } });
    return jsonError(401, "Too many incorrect attempts. Please sign in again.", { next: "/login" });
  }
  return jsonError(400, message);
}
