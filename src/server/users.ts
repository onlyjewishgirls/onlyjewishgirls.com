import "server-only";
import type { ActivityOutcome, StreakState } from "@/lib/streak/engine";
import { all, batch, first, run, type Statement } from "./db";

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
  /** Approximate location, for Shabbat / Yom Tov times. */
  latitude: number | null;
  longitude: number | null;
  country: string | null;
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
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  created_at: number;
}

function toUser(row: UserRow | null): User | null {
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
    latitude: row.latitude,
    longitude: row.longitude,
    country: row.country,
    createdAt: row.created_at,
  };
}

export async function findUserById(id: number): Promise<User | null> {
  return toUser(await first<UserRow>("SELECT * FROM users WHERE id = ?", id));
}

/** Sign in with either the username or the email address. */
export async function findUserByLogin(identifier: string): Promise<User | null> {
  const value = identifier.trim().toLowerCase();
  const column = value.includes("@") ? "email" : "username_lower";
  return toUser(await first<UserRow>(`SELECT * FROM users WHERE ${column} = ?`, value));
}

export async function usernameTaken(username: string): Promise<boolean> {
  return !!(await first("SELECT 1 FROM users WHERE username_lower = ?", username.toLowerCase()));
}

export async function emailTaken(email: string): Promise<boolean> {
  return !!(await first("SELECT 1 FROM users WHERE email = ?", email));
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

export async function createUser(u: NewUser, now: number): Promise<number> {
  const { lastRowId } = await run(
    `INSERT INTO users (first_name, middle_name, last_name, email, username, username_lower, phone_e164,
                        password_hash, time_zone, webauthn_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return lastRowId;
}

export async function updateTimeZone(userId: number, timeZone: string) {
  await run("UPDATE users SET time_zone = ? WHERE id = ?", timeZone, userId);
}

export async function updateLocation(
  userId: number,
  location: { latitude: number | null; longitude: number | null; country: string | null },
) {
  await run(
    "UPDATE users SET latitude = ?, longitude = ?, country = ? WHERE id = ?",
    location.latitude,
    location.longitude,
    location.country,
    userId,
  );
}

export async function saveStreak(userId: number, s: StreakState, event: StreakEvent | null) {
  await run(
    `UPDATE users SET streak_count = ?, streak_longest = ?, streak_last_activity_at = ?,
                      streak_last_counted_date = ?, streak_started_at = ?, streak_last_event = ?
     WHERE id = ?`,
    s.count,
    s.longest,
    s.lastActivityAt,
    s.lastCountedDate,
    s.startedAt,
    event && JSON.stringify(event),
    userId,
  );
}

// ---- Authenticator app (TOTP) ----

export async function setPendingTotpSecret(userId: number, secretEnc: string) {
  await run("UPDATE users SET totp_pending_secret_enc = ? WHERE id = ?", secretEnc, userId);
}

export async function enableTotp(userId: number, step: number, now: number) {
  await run(
    `UPDATE users SET totp_secret_enc = totp_pending_secret_enc, totp_pending_secret_enc = NULL,
                      totp_last_step = ?, totp_enabled_at = ?
     WHERE id = ? AND totp_pending_secret_enc IS NOT NULL`,
    step,
    now,
    userId,
  );
}

/** Atomically records a used TOTP step; false if it (or a later one) was already used. */
export async function claimTotpStep(userId: number, step: number): Promise<boolean> {
  const { changes } = await run(
    "UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
    step,
    userId,
    step,
  );
  return changes === 1;
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
  public_key: string;
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
    publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : [],
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function listPasskeys(userId: number): Promise<Passkey[]> {
  return (await all<PasskeyRow>("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at", userId)).map(toPasskey);
}

export async function findPasskey(userId: number, id: string): Promise<Passkey | null> {
  const row = await first<PasskeyRow>("SELECT * FROM passkeys WHERE user_id = ? AND id = ?", userId, id);
  return row ? toPasskey(row) : null;
}

export async function addPasskey(p: Omit<Passkey, "lastUsedAt">) {
  await run(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    p.id,
    p.userId,
    Buffer.from(p.publicKey).toString("base64url"),
    p.counter,
    JSON.stringify(p.transports),
    p.deviceType,
    p.backedUp ? 1 : 0,
    p.createdAt,
  );
}

export async function markPasskeyUsed(id: string, counter: number, now: number) {
  await run("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", counter, now, id);
}

// ---- Recovery codes ----

export async function replaceRecoveryCodes(userId: number, hashes: string[], now: number) {
  const statements: Statement[] = [
    ["DELETE FROM recovery_codes WHERE user_id = ?", userId],
    ...hashes.map((hash): Statement => ["INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)", userId, hash]),
    ["UPDATE users SET recovery_codes_created_at = ? WHERE id = ?", now, userId],
  ];
  await batch(statements);
}

/** Marks a recovery code as used. Returns how many unused codes remain, or null if the code was invalid. */
export async function consumeRecoveryCode(userId: number, hash: string, now: number): Promise<number | null> {
  const { changes } = await run(
    "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    now,
    userId,
    hash,
  );
  if (changes !== 1) return null;
  const row = await first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
    userId,
  );
  return row?.n ?? 0;
}

export async function hasRecoveryCodes(userId: number): Promise<boolean> {
  return !!(await first("SELECT 1 FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", userId));
}

// ---- Password resets ----

/** Stores a new reset token, replacing any earlier unused ones for the user. */
export async function createPasswordReset(userId: number, tokenHash: string, now: number, expiresAt: number) {
  await batch([
    ["DELETE FROM password_resets WHERE user_id = ?", userId],
    [
      "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      userId,
      now,
      expiresAt,
    ],
  ]);
}

/** The user a reset token belongs to, if the token is unused and unexpired. */
export async function findPasswordResetUser(tokenHash: string, now: number): Promise<User | null> {
  const row = await first<{ user_id: number }>(
    "SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    tokenHash,
    now,
  );
  return row ? findUserById(row.user_id) : null;
}

/**
 * Atomically marks the token used; false if it was already used or expired
 * (so two tabs submitting the same link can't both succeed).
 */
export async function claimPasswordReset(tokenHash: string, userId: number, now: number): Promise<boolean> {
  const { changes } = await run(
    "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?",
    now,
    tokenHash,
    userId,
    now,
  );
  return changes === 1;
}

/** Sets the new password and signs the user out everywhere. */
export async function resetPassword(userId: number, passwordHash: string) {
  await batch([
    ["UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, userId],
    ["DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", userId],
    ["DELETE FROM sessions WHERE user_id = ?", userId],
  ]);
}
