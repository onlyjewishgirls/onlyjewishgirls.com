import "server-only";
import { isRole, type AdminAction, type Role } from "@/lib/admin/permissions";
import type { StreakState } from "@/lib/streak/engine";
import { first, run } from "./db";
import { searchName, type ProfileChanges, type StreakEvent, type User } from "./users";

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

/**
 * Puts the account back. Returns an error message if it can't. Each write only
 * applies if the account still holds exactly what the change left, checked in
 * the same statement, so an edit made in the meantime is never overwritten.
 */
export async function applyUndo(target: User, undo: Undo): Promise<string | null> {
  const applied = ({ changes }: { changes: number }) => (changes === 1 ? null : CHANGED_SINCE);
  switch (undo.kind) {
    case "unsuspend":
      return applied(
        await run(
          "UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND suspended_at IS ?",
          target.id,
          undo.after.suspendedAt,
        ),
      );

    case "suspend": {
      const error = applied(
        await run(
          "UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ? AND suspended_at IS NULL",
          undo.suspendedAt,
          undo.reason,
          target.id,
        ),
      );
      if (!error) await run("DELETE FROM sessions WHERE user_id = ?", target.id);
      return error;
    }

    case "set_role":
      return applied(
        await run(
          "UPDATE users SET role = ? WHERE id = ? AND role = ? AND role != 'owner'",
          undo.role,
          target.id,
          undo.after.role,
        ),
      );

    case "edit_profile": {
      const p = undo.profile;
      const a = undo.after;
      if (await first("SELECT 1 FROM users WHERE username_lower = ? AND id != ?", p.username.toLowerCase(), target.id)) {
        return `Someone else has the username "${p.username}" now.`;
      }
      if (await first("SELECT 1 FROM users WHERE email = ? AND id != ?", p.email, target.id)) {
        return `Someone else uses ${p.email} now.`;
      }
      return applied(
        await run(
          `UPDATE users SET first_name = ?, middle_name = ?, last_name = ?, email = ?, username = ?, username_lower = ?,
                            phone_e164 = ?, search_name = ?
           WHERE id = ? AND first_name IS ? AND middle_name IS ? AND last_name IS ? AND email IS ? AND username IS ?
             AND phone_e164 IS ?`,
          p.firstName,
          p.middleName,
          p.lastName,
          p.email,
          p.username,
          p.username.toLowerCase(),
          p.phone,
          searchName(p.firstName, p.middleName, p.lastName),
          target.id,
          a.firstName,
          a.middleName,
          a.lastName,
          a.email,
          a.username,
          a.phone,
        ),
      );
    }

    case "set_streak": {
      const st = undo.state;
      return applied(
        await run(
          `UPDATE users SET streak_count = ?, streak_longest = ?, streak_last_activity_at = ?,
                            streak_last_counted_date = ?, streak_started_at = ?, streak_last_event = ?
           WHERE id = ? AND streak_count = ? AND streak_last_activity_at IS ?`,
          st.count,
          st.longest,
          st.lastActivityAt,
          st.lastCountedDate,
          st.startedAt,
          undo.event && JSON.stringify(undo.event),
          target.id,
          undo.after.count,
          undo.after.lastActivityAt,
        ),
      );
    }

    case "set_note":
      return applied(
        await run("UPDATE users SET admin_note = ? WHERE id = ? AND admin_note IS ?", undo.note, target.id, undo.after.note),
      );
  }
}
