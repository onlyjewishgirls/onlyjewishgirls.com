/** Everything recorded in the activity log, with how the admin panel describes it. */

export const EVENT_LABELS = {
  "account.created": "Created an account",
  "signin.password": "Entered the correct password",
  "signin.failed": "Wrong password",
  "signin.unknown": "Tried to sign in to an account that doesn't exist",
  "signin.rate_limited": "Locked out after too many sign-in attempts",
  "signin.suspended": "Blocked: account is suspended",
  "signin.complete": "Signed in",
  "signin.mfa_failed": "Failed two-step verification",
  "signin.mfa_locked": "Locked out after too many two-step failures",
  "signout": "Signed out",
  "mfa.passkey_added": "Added a passkey",
  "mfa.totp_enabled": "Connected an authenticator app",
  "mfa.recovery_codes": "Created recovery codes",
  "password.reset_requested": "Asked for a password reset email",
  "password.reset": "Reset their password",
  "password.changed": "Changed their password",
  "streak.started": "Started a streak",
  "streak.continued": "Extended their streak",
  "streak.restarted": "Lost their streak and started again",
  "admin.verified": "Re-verified for admin actions",
  "admin.suspend": "Suspended the account",
  "admin.unsuspend": "Lifted the suspension",
  "admin.sign_out_everywhere": "Signed the account out everywhere",
  "admin.revoke_session": "Signed out one device",
  "admin.unlock_sign_in": "Unlocked sign-in",
  "admin.send_password_reset": "Sent a password reset email",
  "admin.remove_passkey": "Removed a passkey",
  "admin.disable_totp": "Turned off the authenticator app",
  "admin.clear_recovery_codes": "Deleted the recovery codes",
  "admin.reset_two_step": "Reset two-step sign-in",
  "admin.edit_profile": "Edited the profile",
  "admin.set_streak": "Changed the streak",
  "admin.set_note": "Updated the admin note",
  "admin.set_temp_password": "Set a temporary password",
  "admin.create_account": "Created the account",
  "admin.revert": "Undid an admin change",
  "admin.set_role": "Changed the role",
  "admin.delete": "Deleted the account",
  "admin.export": "Exported all accounts",
} as const;

export type EventType = keyof typeof EVENT_LABELS;

export function eventLabel(type: string): string {
  return (EVENT_LABELS as Record<string, string>)[type] ?? type;
}

/** Filters on the activity page. */
export const EVENT_GROUPS = {
  all: { label: "Everything", prefix: null },
  signin: { label: "Sign-ins", prefix: "signin." },
  security: { label: "Two-step & passwords", prefix: null },
  admin: { label: "Admin actions", prefix: "admin." },
  account: { label: "New accounts", prefix: "account." },
  streak: { label: "Streaks", prefix: "streak." },
} as const;
export type EventGroup = keyof typeof EVENT_GROUPS;

export function isEventGroup(value: unknown): value is EventGroup {
  return typeof value === "string" && Object.hasOwn(EVENT_GROUPS, value);
}

/** Events worth a second look: shown in red. */
export function isWarningEvent(type: string): boolean {
  return (
    type === "signin.failed" ||
    type === "signin.unknown" ||
    type === "signin.rate_limited" ||
    type === "signin.suspended" ||
    type === "signin.mfa_failed" ||
    type === "signin.mfa_locked" ||
    type === "admin.suspend" ||
    type === "admin.delete"
  );
}
