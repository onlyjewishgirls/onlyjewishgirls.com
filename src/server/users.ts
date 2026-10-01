import "server-only";
import type { ActivityOutcome, StreakState } from "@/lib/streak/engine";
import { db } from "./db";

/** The streak change from the day's first check-in, so the page can keep showing it all day. */
export interface StreakEvent {
  date: string;
  outcome: Exclude<ActivityOutcome, "same-day">;
  added: number;
  previousCount: number;
}

export interface User {
  id: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
  email: string;
  username: string;
  phone: string;
  passwordHash: string;
  timeZone: string;
  webauthnUserId: string;
  totpSecretEnc: string | null;
  totpPendingSecretEnc: string | null;
  totpLastStep: number | null;
  totpEnabledAt: number | null;
  recoveryCodesCreatedAt: number | null;
  streak: StreakState;
  streakLastEvent: StreakEvent | null;
  createdAt: number;
}

interface UserRow {
  id: number;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  email: string;
  username: string;
  phone_e164: string;
  password_hash: string;
  time_zone: string;
  webauthn_user_id: string;
  totp_secret_enc: string | null;
  totp_pending_secret_enc: string | null;
  totp_last_step: number | null;
  totp_enabled_at: number | null;
  recovery_codes_created_at: number | null;
  streak_count: number;
  streak_longest: number;
  streak_last_activity_at: number | null;
  streak_last_counted_date: string | null;
  streak_started_at: number | null;
  streak_last_event: string | null;
  created_at: number;
}

function toUser(row: UserRow | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    email: row.email,
    username: row.username,
    phone: row.phone_e164,
    passwordHash: row.password_hash,
    timeZone: row.time_zone,
    webauthnUserId: row.webauthn_user_id,
    totpSecretEnc: row.totp_secret_enc,
    totpPendingSecretEnc: row.totp_pending_secret_enc,
    totpLastStep: row.totp_last_step,
    totpEnabledAt: row.totp_enabled_at,
    recoveryCodesCreatedAt: row.recovery_codes_created_at,
    streak: {
      count: row.streak_count,
      longest: row.streak_longest,
      lastActivityAt: row.streak_last_activity_at,
      lastCountedDate: row.streak_last_counted_date,
      startedAt: row.streak_started_at,
    },
    streakLastEvent: row.streak_last_event ? JSON.parse(row.streak_last_event) : null,
    createdAt: row.created_at,
  };
}

export function findUserById(id: number): User | null {
  return toUser(db().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined);
}

/** Sign in with either the username or the email address. */
export function findUserByLogin(identifier: string): User | null {
  const value = identifier.trim().toLowerCase();
  const column = value.includes("@") ? "email" : "username_lower";
  return toUser(db().prepare(`SELECT * FROM users WHERE ${column} = ?`).get(value) as UserRow | undefined);
}

export function usernameTaken(username: string): boolean {
  return !!db().prepare("SELECT 1 FROM users WHERE username_lower = ?").get(username.toLowerCase());
}

export function emailTaken(email: string): boolean {
  return !!db().prepare("SELECT 1 FROM users WHERE email = ?").get(email);
}

export interface NewUser {
  firstName: string;
  middleName: string | null;
  lastName: string;
  email: string;
  username: string;
  phone: string;
  passwordHash: string;
  timeZone: string;
  webauthnUserId: string;
}

export function createUser(u: NewUser, now: number): number {
  const result = db()
    .prepare(
      `INSERT INTO users (first_name, middle_name, last_name, email, username, username_lower, phone_e164,
                          password_hash, time_zone, webauthn_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      u.firstName,
      u.middleName,
      u.lastName,
      u.email,
      u.username,
      u.username.toLowerCase(),
      u.phone,
      u.passwordHash,
      u.timeZone,
      u.webauthnUserId,
      now,
    );
  return Number(result.lastInsertRowid);
}

export function updateTimeZone(userId: number, timeZone: string) {
  db().prepare("UPDATE users SET time_zone = ? WHERE id = ?").run(timeZone, userId);
}

export function saveStreak(userId: number, s: StreakState, event: StreakEvent | null) {
  db()
    .prepare(
      `UPDATE users SET streak_count = ?, streak_longest = ?, streak_last_activity_at = ?,
                        streak_last_counted_date = ?, streak_started_at = ?, streak_last_event = ?
       WHERE id = ?`,
    )
    .run(s.count, s.longest, s.lastActivityAt, s.lastCountedDate, s.startedAt, event && JSON.stringify(event), userId);
}

// ---- Authenticator app (TOTP) ----

export function setPendingTotpSecret(userId: number, secretEnc: string) {
  db().prepare("UPDATE users SET totp_pending_secret_enc = ? WHERE id = ?").run(secretEnc, userId);
}

export function enableTotp(userId: number, step: number, now: number) {
  db()
    .prepare(
      `UPDATE users SET totp_secret_enc = totp_pending_secret_enc, totp_pending_secret_enc = NULL,
                        totp_last_step = ?, totp_enabled_at = ?
       WHERE id = ? AND totp_pending_secret_enc IS NOT NULL`,
    )
    .run(step, now, userId);
}

/** Atomically records a used TOTP step; false if it (or a later one) was already used. */
export function claimTotpStep(userId: number, step: number): boolean {
  const result = db()
    .prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)")
    .run(step, userId, step);
  return result.changes === 1;
}

// ---- Passkeys ----

export interface Passkey {
  id: string;
  userId: number;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

interface PasskeyRow {
  id: string;
  user_id: number;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

function toPasskey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    userId: row.user_id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : [],
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function listPasskeys(userId: number): Passkey[] {
  return (db().prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at").all(userId) as PasskeyRow[]).map(
    toPasskey,
  );
}

export function findPasskey(userId: number, id: string): Passkey | null {
  const row = db().prepare("SELECT * FROM passkeys WHERE user_id = ? AND id = ?").get(userId, id) as
    | PasskeyRow
    | undefined;
  return row ? toPasskey(row) : null;
}

export function addPasskey(p: Omit<Passkey, "lastUsedAt">) {
  db()
    .prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.id, p.userId, Buffer.from(p.publicKey), p.counter, JSON.stringify(p.transports), p.deviceType, p.backedUp ? 1 : 0, p.createdAt);
}

export function markPasskeyUsed(id: string, counter: number, now: number) {
  db().prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, now, id);
}

// ---- Recovery codes ----

export function replaceRecoveryCodes(userId: number, hashes: string[], now: number) {
  const conn = db();
  conn.transaction(() => {
    conn.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    const insert = conn.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const hash of hashes) insert.run(userId, hash);
    conn.prepare("UPDATE users SET recovery_codes_created_at = ? WHERE id = ?").run(now, userId);
  })();
}

/** Marks a recovery code as used. Returns how many unused codes remain, or null if the code was invalid. */
export function consumeRecoveryCode(userId: number, hash: string, now: number): number | null {
  const conn = db();
  const result = conn
    .prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .run(now, userId, hash);
  if (result.changes !== 1) return null;
  const row = conn.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId) as {
    n: number;
  };
  return row.n;
}

export function hasRecoveryCodes(userId: number): boolean {
  return !!db().prepare("SELECT 1 FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId);
}
