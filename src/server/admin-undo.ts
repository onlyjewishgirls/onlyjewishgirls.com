import "server-only";
import { isRole, type AdminAction, type Role } from "@/lib/admin/permissions";
import type { StreakState } from "@/lib/streak/engine";
import { first } from "./db";
import {
  restoreSuspension,
  saveStreak,
  setAdminNote,
  setRole,
  unsuspendUser,
  updateProfile,
  type ProfileChanges,
  type StreakEvent,
  type User,
} from "./users";

/**
 * How to reverse an admin change, stored with its activity-log entry. Each
 * records the state the change produced (`after`); an undo is refused if the
 * account has changed since, so it never silently overwrites a newer edit.
 */
export type Undo =
  | { kind: "unsuspend"; after: { suspendedAt: number } }
  | { kind: "suspend"; suspendedAt: number; reason: string | null }
  | { kind: "set_role"; role: Role; after: { role: Role } }
  | { kind: "edit_profile"; profile: ProfileChanges; after: ProfileChanges }
  | { kind: "set_streak"; state: StreakState; event: StreakEvent | null; after: { count: number; lastActivityAt: number | null } }
  | { kind: "set_note"; note: string | null; after: { note: string | null } };

/** The admin action an undo amounts to, for the permission check. */
export function undoAction(undo: Undo): AdminAction {
  return undo.kind;
}

export function profileOf(user: User): ProfileChanges {
  return {
    firstName: user.firstName,
    middleName: user.middleName,
    lastName: user.lastName,
    email: user.email,
    username: user.username,
    phone: user.phone,
  };
}

const sameProfile = (a: ProfileChanges, b: ProfileChanges) =>
  (Object.keys(a) as (keyof ProfileChanges)[]).every((key) => a[key] === b[key]);

const CHANGED_SINCE = "This account has changed again since. Undo the newer change first.";

export function parseUndo(json: string | null): Undo | null {
  if (!json) return null;
  try {
    const undo = JSON.parse(json) as Undo;
    if (undo.kind === "set_role" && !isRole(undo.role)) return null;
    return undo;
  } catch {
    return null;
  }
}

/** Puts the account back. Returns an error message if it can't. */
export async function applyUndo(target: User, undo: Undo): Promise<string | null> {
  switch (undo.kind) {
    case "unsuspend":
      if (target.suspendedAt !== undo.after.suspendedAt) return CHANGED_SINCE;
      await unsuspendUser(target.id);
      return null;

    case "suspend":
      if (target.suspendedAt !== null) return CHANGED_SINCE;
      await restoreSuspension(target.id, undo.suspendedAt, undo.reason);
      return null;

    case "set_role":
      if (target.role !== undo.after.role || target.role === "owner") return CHANGED_SINCE;
      await setRole(target.id, undo.role);
      return null;

    case "edit_profile": {
      if (!sameProfile(profileOf(target), undo.after)) return CHANGED_SINCE;
      const p = undo.profile;
      if (await first("SELECT 1 FROM users WHERE username_lower = ? AND id != ?", p.username.toLowerCase(), target.id)) {
        return `Someone else has the username "${p.username}" now.`;
      }
      if (await first("SELECT 1 FROM users WHERE email = ? AND id != ?", p.email, target.id)) {
        return `Someone else uses ${p.email} now.`;
      }
      await updateProfile(target.id, p);
      return null;
    }

    case "set_streak":
      if (target.streak.count !== undo.after.count || target.streak.lastActivityAt !== undo.after.lastActivityAt) {
        return CHANGED_SINCE;
      }
      await saveStreak(target.id, undo.state, undo.event);
      return null;

    case "set_note":
      if (target.adminNote !== undo.after.note) return CHANGED_SINCE;
      await setAdminNote(target.id, undo.note);
      return null;
  }
}
