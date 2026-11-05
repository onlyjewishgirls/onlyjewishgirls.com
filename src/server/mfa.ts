import "server-only";
import type { SessionStage } from "./session";
import { emailOtpAvailability } from "./email-otp";
import { hasRecoveryCodes, listPasskeys, type User } from "./users";

export interface MfaState {
  passkeys: number;
  totp: boolean;
  recoveryCodes: boolean;
  /**
   * Email codes can be used right now: email configured, on for this person, no recent reset by
   * email link, and the account has set up two-step sign-in before (a brand-new account, or one an
   * admin reset, sets up a passkey and an authenticator app first, as always).
   */
  email: boolean;
  /** Second factors the user can sign in with (email counts, so it guards enrolment too). */
  factors: number;
  /** Passkey + authenticator app + recovery codes all set up. */
  complete: boolean;
}

export async function mfaState(user: User): Promise<MfaState> {
  const [passkeys, unusedRecoveryCodes, emailAvailable] = await Promise.all([
    listPasskeys(user.id).then((list) => list.length),
    hasRecoveryCodes(user.id),
    emailOtpAvailability(user).then((a) => a.ok),
  ]);
  const totp = user.totpEnabledAt !== null;
  const recoveryCodes = user.recoveryCodesCreatedAt !== null;
  const email = emailAvailable && (passkeys > 0 || totp || recoveryCodes);
  return {
    passkeys,
    totp,
    recoveryCodes,
    email,
    factors: (passkeys > 0 ? 1 : 0) + (totp ? 1 : 0) + (email ? 1 : 0) + (unusedRecoveryCodes ? 1 : 0),
    complete: passkeys > 0 && totp && recoveryCodes,
  };
}

export type NextStep = "/login/verify" | "/setup-mfa" | "/change-password" | "/home";

/**
 * Where a signed-in person must go next. Choosing their own password (after an
 * admin set a temporary one) comes last, once they're fully verified.
 */
export function nextStep(stage: SessionStage, mfa: MfaState, mustChangePassword = false): NextStep {
  if (stage === "password") return mfa.factors > 0 ? "/login/verify" : "/setup-mfa";
  if (!mfa.complete) return "/setup-mfa";
  return mustChangePassword ? "/change-password" : "/home";
}

/**
 * A new factor may be added by a fully signed-in session, or — only for the
 * very first factor — right after the password. Once any factor exists it
 * must be used before more can be added, so a stolen password alone can't
 * attach an attacker's authenticator.
 */
export function canEnroll(stage: SessionStage, mfa: MfaState): boolean {
  return stage === "full" || mfa.factors === 0;
}
