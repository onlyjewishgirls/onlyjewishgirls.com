import parseMax from "libphonenumber-js/max";
import { NextResponse } from "next/server";
import { ASSIGNABLE_ROLES, ROLE_LABELS, can, isAdminAction, isRole, type AdminAction } from "@/lib/admin/permissions";
import { localDate } from "@/lib/streak/dates";
import { normalizeEmail, normalizeName, validateEmail, validateName, validatePhone, validateUsername } from "@/lib/validation";
import { recentlyVerified, requireAdminApi } from "@/server/admin";
import { profileOf, type Undo } from "@/server/admin-undo";
import { first } from "@/server/db";
import { logEvent } from "@/server/events";
import { api, jsonError, readJson, str } from "@/server/http";
import { mfaFailureKey } from "@/server/mfa-routes";
import { hashPassword } from "@/server/passwords";
import { sendPasswordResetEmail } from "@/server/password-reset";
import { rateLimit, resetRateLimit } from "@/server/rate-limit";
import { generateTemporaryPassword } from "@/server/temp-password";
import {
  clearRecoveryCodes,
  deleteSession,
  deleteSessions,
  deleteUser,
  disableTotp,
  findUserById,
  removePasskey,
  resetTwoStep,
  saveStreak,
  setAdminNote,
  setRole,
  setTemporaryPassword,
  suspendUser,
  unsuspendUser,
  updateProfile,
  type ProfileChanges,
} from "@/server/users";

const MAX_NOTE = 2000;
const MAX_REASON = 500;
const MAX_STREAK = 100_000;

type Fields = Partial<Record<keyof ProfileChanges, string>>;

/**
 * Every change an admin makes to an account goes through here, so the
 * permission check, the fresh second-factor check and the audit log can't be
 * skipped by one action.
 */
export const POST = api(async (req) => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { ctx } = guard;
  const actor = ctx.user;

  const body = await readJson(req);
  const action = body.action;
  if (!isAdminAction(action)) return jsonError(400, "Unknown action.");
  const target = Number.isSafeInteger(body.userId) ? await findUserById(body.userId as number) : null;
  if (!target) return jsonError(404, "That account doesn't exist anymore.");
  if (!can(actor, action, target)) return jsonError(403, "You don't have permission to do that to this account.");
  // A page left open on a deleted account must not act on a new account that got the same id.
  if (str(body.expectUsername) !== target.username) {
    return jsonError(409, "This account has changed since the page loaded. Reload and try again.");
  }

  const now = Date.now();
  if (!recentlyVerified(ctx.session, now)) {
    return jsonError(403, "Confirm it's you to make changes.", { verify: true });
  }
  const limit = await rateLimit(`admin:${actor.id}`, 300, 60 * 60_000, now);
  if (!limit.ok) return jsonError(429, "That's a lot of changes at once. Wait a few minutes and try again.");

  const done = async (message: string, detail?: Record<string, unknown>, undo?: Undo, extra: Record<string, unknown> = {}) => {
    await logEvent(`admin.${action as AdminAction}`, { user: target, actor, detail, undo, now });
    return NextResponse.json({ ok: true, message, ...extra });
  };

  switch (action) {
    case "suspend": {
      if (target.suspendedAt !== null) return jsonError(409, "This account is already suspended.");
      const reason = str(body.reason).trim().slice(0, MAX_REASON) || null;
      await suspendUser(target.id, reason, now);
      return done(`${target.username} is suspended and signed out everywhere.`, { reason }, {
        kind: "unsuspend",
        after: { suspendedAt: now },
      });
    }

    case "unsuspend": {
      if (target.suspendedAt === null) return jsonError(409, "This account isn't suspended.");
      await unsuspendUser(target.id);
      return done(`${target.username} can sign in again.`, undefined, {
        kind: "suspend",
        suspendedAt: target.suspendedAt,
        reason: target.suspendedReason,
      });
    }

    case "sign_out_everywhere": {
      // On your own account, keep this device signed in.
      const keep = target.id === actor.id ? ctx.session.idHash : null;
      const count = await deleteSessions(target.id, keep);
      return done(
        count === 0 ? "There were no other sessions to end." : `Ended ${count} session${count === 1 ? "" : "s"}.`,
        { sessions: count },
      );
    }

    case "revoke_session": {
      const sessionId = str(body.sessionId);
      if (sessionId === ctx.session.idHash) return jsonError(400, "That's this device. Use Sign out instead.");
      if (!(await deleteSession(target.id, sessionId))) return jsonError(404, "That session already ended.");
      return done("That device is signed out.");
    }

    case "unlock_sign_in": {
      await resetRateLimit(`login:account:${target.id}`);
      await resetRateLimit(mfaFailureKey(target.id));
      return done(`${target.username} can try signing in again right away.`);
    }

    case "send_password_reset": {
      if (target.suspendedAt !== null) return jsonError(409, "Lift the suspension first. Reset links don't work on suspended accounts.");
      await sendPasswordResetEmail(req, target, now);
      return done(`Sent a password reset link to ${target.email}. It works once and expires in 30 minutes.`);
    }

    case "set_temp_password": {
      const password = generateTemporaryPassword({
        firstName: target.firstName,
        middleName: target.middleName ?? "",
        lastName: target.lastName,
        username: target.username,
        email: target.email,
        phone: target.phone,
      });
      await setTemporaryPassword(target.id, await hashPassword(password));
      // The password itself is never logged or stored; it's shown to the admin this once.
      return done(
        `Temporary password set. ${target.username} is signed out everywhere and must choose a new password after signing in.`,
        undefined,
        undefined,
        { temporaryPassword: password },
      );
    }

    case "remove_passkey": {
      const passkeyId = str(body.passkeyId);
      if (!(await removePasskey(target.id, passkeyId))) return jsonError(404, "That passkey was already removed.");
      return done("Passkey removed. They'll be asked to add a new one next time they sign in.", {
        passkey: passkeyId.slice(0, 12),
      });
    }

    case "disable_totp": {
      if (target.totpEnabledAt === null && target.totpPendingSecretEnc === null) {
        return jsonError(409, "They don't have an authenticator app connected.");
      }
      await disableTotp(target.id);
      return done("Authenticator app turned off. They'll be asked to connect one next time they sign in.");
    }

    case "clear_recovery_codes": {
      await clearRecoveryCodes(target.id);
      return done("Recovery codes deleted. They'll get new ones next time they sign in.");
    }

    case "reset_two_step": {
      await resetTwoStep(target.id);
      return done(
        `Two-step sign-in reset for ${target.username}. After their password they'll set up a passkey and an authenticator app again.`,
      );
    }

    case "edit_profile": {
      const input = {
        firstName: str(body.firstName),
        middleName: str(body.middleName),
        lastName: str(body.lastName),
        email: str(body.email),
        username: str(body.username).trim(),
        phone: str(body.phone),
        phoneCountry: str(body.phoneCountry) || "US",
      };
      const fields: Fields = {};
      const set = (key: keyof Fields, error: string | undefined) => {
        if (error) fields[key] = error;
      };
      set("firstName", validateName(input.firstName, "First name"));
      if (input.middleName.trim()) set("middleName", validateName(input.middleName, "Middle name"));
      set("lastName", validateName(input.lastName, "Last name"));
      set("email", validateEmail(input.email));
      set("username", validateUsername(input.username));
      set("phone", validatePhone(input.phone, input.phoneCountry));
      const email = normalizeEmail(input.email);
      const phone = parseMax(input.phone.trim(), input.phoneCountry as Parameters<typeof parseMax>[1]);
      if (
        !fields.username &&
        (await first("SELECT 1 FROM users WHERE username_lower = ? AND id != ?", input.username.toLowerCase(), target.id))
      ) {
        fields.username = "That username is taken";
      }
      if (!fields.email && (await first("SELECT 1 FROM users WHERE email = ? AND id != ?", email, target.id))) {
        fields.email = "Another account already uses this email";
      }
      if (Object.keys(fields).length > 0 || !phone) {
        return jsonError(400, "Please fix the highlighted fields.", { fields });
      }
      const changes: ProfileChanges = {
        firstName: normalizeName(input.firstName),
        middleName: input.middleName.trim() ? normalizeName(input.middleName) : null,
        lastName: normalizeName(input.lastName),
        email,
        username: input.username,
        phone: phone.number,
      };
      const changed = (Object.keys(changes) as (keyof ProfileChanges)[]).filter((key) => {
        const before = key === "phone" ? target.phone : target[key];
        return before !== changes[key];
      });
      if (changed.length === 0) return NextResponse.json({ ok: true, message: "Nothing changed." });
      try {
        await updateProfile(target.id, changes);
      } catch (error) {
        if (/UNIQUE constraint failed/.test(String((error as Error)?.message))) {
          return jsonError(409, "That username or email was just taken by someone else.");
        }
        throw error;
      }
      return done("Profile saved.", { changed }, { kind: "edit_profile", profile: profileOf(target), after: changes });
    }

    case "set_streak": {
      const count = Number(body.count);
      if (!Number.isInteger(count) || count < 0 || count > MAX_STREAK) {
        return jsonError(400, `Enter a whole number from 0 to ${MAX_STREAK.toLocaleString()}.`);
      }
      const state =
        count === 0
          ? { count: 0, longest: target.streak.longest, lastActivityAt: null, lastCountedDate: null, startedAt: null }
          : {
              count,
              longest: Math.max(target.streak.longest, count),
              // The new streak counts as checked in today, so their next deadline starts now.
              lastActivityAt: now,
              lastCountedDate: localDate(now, target.timeZone),
              startedAt: target.streak.startedAt ?? now,
            };
      await saveStreak(target.id, state, null);
      return done(
        count === 0 ? "Streak reset to 0." : `Streak set to ${count}. Their 30-hour window starts now.`,
        { from: target.streak.count, to: count },
        {
          kind: "set_streak",
          state: target.streak,
          event: target.streakLastEvent,
          after: { count: state.count, lastActivityAt: state.lastActivityAt },
        },
      );
    }

    case "set_note": {
      const note = str(body.note).trim().slice(0, MAX_NOTE) || null;
      if (note === target.adminNote) return NextResponse.json({ ok: true, message: "Nothing changed." });
      await setAdminNote(target.id, note);
      return done(note ? "Note saved." : "Note cleared.", undefined, {
        kind: "set_note",
        note: target.adminNote,
        after: { note },
      });
    }

    case "set_role": {
      const role = body.role;
      if (!isRole(role) || !ASSIGNABLE_ROLES.includes(role)) return jsonError(400, "Pick Member or Admin.");
      if (role === target.role) return NextResponse.json({ ok: true, message: "Nothing changed." });
      await setRole(target.id, role);
      return done(
        `${target.username} is now ${role === "admin" ? "an" : "a"} ${ROLE_LABELS[role]}.`,
        { from: target.role, to: role },
        { kind: "set_role", role: target.role, after: { role } },
      );
    }

    case "delete": {
      if (str(body.confirm).trim().toLowerCase() !== target.username.toLowerCase()) {
        return jsonError(400, `Type the username "${target.username}" to confirm.`);
      }
      // Logged first: the log entry keeps the username after the account is gone.
      await logEvent("admin.delete", { user: target, actor, now });
      await deleteUser(target.id);
      return NextResponse.json({ ok: true, message: `${target.username}'s account was deleted.`, next: "/admin/users" });
    }
  }
});
