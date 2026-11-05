/**
 * PORTAL-STANDARD §3: second factors are always listed passkey, authenticator
 * app (TOTP), email. This site has no email codes; recovery codes come last.
 */
export const MFA_ORDER = ["passkey", "totp", "email", "recovery"] as const;
export type MfaKind = (typeof MFA_ORDER)[number];

export const MFA_LABELS: Record<MfaKind, string> = {
  passkey: "Passkey",
  totp: "Authenticator app",
  email: "Email code",
  recovery: "Recovery codes",
};

/** Sorts any list of kinds into the canonical order. */
export function sortMfa<T extends MfaKind>(kinds: readonly T[]): T[] {
  return [...kinds].sort((a, b) => MFA_ORDER.indexOf(a) - MFA_ORDER.indexOf(b));
}

/** The method to start with: the preferred one when enrolled, else the first enrolled in canonical order. */
export function defaultMfaMethod(enrolled: Partial<Record<MfaKind, boolean>>, preferred: MfaKind = "passkey"): MfaKind | null {
  if (enrolled[preferred]) return preferred;
  return MFA_ORDER.find((m) => enrolled[m]) ?? null;
}
