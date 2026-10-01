import "server-only";
import type { SessionStage } from "./session";
import { hasRecoveryCodes, listPasskeys, type User } from "./users";

export interface MfaState {
  passkeys: number;
  totp: boolean;
  recoveryCodes: boolean;
  /** Second factors the user can sign in with. */
  factors: number;
  /** Passkey + authenticator app + recovery codes all set up. */
  complete: boolean;
}

export async function mfaState(user: User): Promise<MfaState> {
  const [passkeys, unusedRecoveryCodes] = await Promise.all([
    listPasskeys(user.id).then((list) => list.length),
    hasRecoveryCodes(user.id),
  ]);
  const totp = user.totpEnabledAt !== null;
  const recoveryCodes = user.recoveryCodesCreatedAt !== null;
  return {
    passkeys,
    totp,
    recoveryCodes,
    factors: (passkeys > 0 ? 1 : 0) + (totp ? 1 : 0) + (unusedRecoveryCodes ? 1 : 0),
    complete: passkeys > 0 && totp && recoveryCodes,
  };
}

export type NextStep = "/login/verify" | "/setup-mfa" | "/home";

export function nextStep(stage: SessionStage, mfa: MfaState): NextStep {
  if (stage === "password") return mfa.factors > 0 ? "/login/verify" : "/setup-mfa";
  return mfa.complete ? "/home" : "/setup-mfa";
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
