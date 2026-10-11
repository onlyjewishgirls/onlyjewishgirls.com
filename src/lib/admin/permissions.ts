/**
 * Who can do what in the admin panel. Shared by the server (which enforces it)
 * and the browser (which only uses it to hide buttons).
 *
 * - owner: the site owner. Can do everything, including making and removing admins.
 * - admin: can see everything and manage members, but not other admins or the owner.
 * - member: everyone else.
 *
 * Nobody can suspend, delete, demote or reset the two-step sign-in of their own
 * account from the panel, so an admin can't lock themselves out by accident.
 */

export const ROLES = ["member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { member: "Member", admin: "Admin", owner: "Owner" };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isAdminRole(role: Role): boolean {
  return role === "admin" || role === "owner";
}

export const ADMIN_ACTIONS = [
  "suspend",
  "unsuspend",
  "sign_out_everywhere",
  "revoke_session",
  "unlock_sign_in",
  "send_password_reset",
  "set_temp_password",
  "remove_passkey",
  "disable_totp",
  "clear_recovery_codes",
  "reset_two_step",
  "edit_profile",
  "set_streak",
  "set_note",
  "set_role",
  "delete",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export function isAdminAction(value: unknown): value is AdminAction {
  return typeof value === "string" && (ADMIN_ACTIONS as readonly string[]).includes(value);
}

/** Actions that would lock an admin out of, or remove, their own account. */
const NOT_ON_SELF = new Set<AdminAction>([
  "suspend",
  "unsuspend",
  "set_temp_password",
  "remove_passkey",
  "disable_totp",
  "clear_recovery_codes",
  "reset_two_step",
  "set_role",
  "delete",
]);

interface Account {
  id: number;
  role: Role;
}

/** Whether `actor` may perform `action` on `target`. */
export function can(actor: Account, action: AdminAction, target: Account): boolean {
  if (!isAdminRole(actor.role)) return false;
  if (actor.id === target.id) return !NOT_ON_SELF.has(action);
  if (target.role === "owner") return false;
  if (action === "set_role") return actor.role === "owner";
  if (target.role === "admin") return actor.role === "owner";
  return true;
}

/** Every action `actor` may perform on `target`. */
export function allowedActions(actor: Account, target: Account): AdminAction[] {
  return ADMIN_ACTIONS.filter((action) => can(actor, action, target));
}

/** Roles the owner can give someone from the panel. There is only ever one owner. */
export const ASSIGNABLE_ROLES: readonly Role[] = ["member", "admin"];

/** Admins create members; only the owner can create another admin. */
export function canCreate(actor: Account, role: Role): boolean {
  if (!isAdminRole(actor.role) || role === "owner") return false;
  return role === "member" || actor.role === "owner";
}

/**
 * Undoing a change from the activity log is owner-only (as on the owner's
 * other sites), and still needs the owner to be allowed the original action.
 */
export function canRevert(actor: Account, action: AdminAction, target: Account): boolean {
  return actor.role === "owner" && can(actor, action, target);
}
