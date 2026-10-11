import "server-only";
import { cookies } from "next/headers";
import { randomToken, sha256 } from "./crypto";
import { all, first, run } from "./db";
import { isLocalHost, requestHost } from "./env";
import { requestInfo } from "./events";
import { findUserById, type User } from "./users";

/**
 * "password" = password checked, second factor not yet verified (or not yet set up).
 * "full"     = fully signed in.
 */
export type SessionStage = "password" | "full";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PENDING_LIFETIME_MS = 15 * MINUTE;
const FULL_LIFETIME_MS = 14 * DAY;
const FULL_IDLE_TIMEOUT_MS = 3 * DAY;
const CHALLENGE_LIFETIME_MS = 5 * MINUTE;
export const MAX_MFA_FAILURES = 5;

/**
 * The deployed site uses a __Host- cookie: HTTPS only, and no subdomain can set
 * or overwrite it. localhost is plain HTTP, so local development uses a plain name.
 */
async function sessionCookie() {
  return isLocalHost(await requestHost())
    ? { name: "ojg_session", secure: false }
    : { name: "__Host-ojg_session", secure: true };
}

export interface Session {
  idHash: string;
  userId: number;
  stage: SessionStage;
  challenge: string | null;
  challengeExpiresAt: number | null;
  failedMfaAttempts: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** Last time a second factor was checked on this session (sign-in or admin re-verification). */
  verifiedAt: number | null;
  ip: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
}

interface SessionRow {
  id_hash: string;
  user_id: number;
  stage: SessionStage;
  challenge: string | null;
  challenge_expires_at: number | null;
  failed_mfa_attempts: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  verified_at: number | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  city: string | null;
}

function toSession(row: SessionRow): Session {
  return {
    idHash: row.id_hash,
    userId: row.user_id,
    stage: row.stage,
    challenge: row.challenge,
    challengeExpiresAt: row.challenge_expires_at,
    failedMfaAttempts: row.failed_mfa_attempts,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
    ip: row.ip,
    userAgent: row.user_agent,
    country: row.country,
    city: row.city,
  };
}

/**
 * Starts a fresh session (new random ID every time the privilege level
 * changes, so a stolen pre-login cookie is worthless). Route handlers only.
 */
export async function startSession(userId: number, stage: SessionStage, now = Date.now()): Promise<void> {
  await endSession();
  await run("DELETE FROM sessions WHERE expires_at <= ?", now);
  const token = randomToken();
  const expiresAt = now + (stage === "full" ? FULL_LIFETIME_MS : PENDING_LIFETIME_MS);
  const info = await requestInfo();
  await run(
    `INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at, verified_at,
                           ip, user_agent, country, city)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    stage,
    now,
    now,
    expiresAt,
    // A session only becomes "full" right after a second factor (or the very first one being set up).
    stage === "full" ? now : null,
    info.ip,
    info.userAgent,
    info.country,
    info.city,
  );
  const cookie = await sessionCookie();
  (await cookies()).set(cookie.name, token, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

/** Route handlers only. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  const { name } = await sessionCookie();
  const token = store.get(name)?.value;
  if (token) {
    await run("DELETE FROM sessions WHERE id_hash = ?", sha256(token));
    store.delete(name);
  }
}

export interface AuthContext {
  session: Session;
  user: User;
}

export async function getAuth(now = Date.now()): Promise<AuthContext | null> {
  const token = (await cookies()).get((await sessionCookie()).name)?.value;
  if (!token) return null;
  const row = await first<SessionRow>("SELECT * FROM sessions WHERE id_hash = ?", sha256(token));
  if (!row) return null;
  const session = toSession(row);
  const idle = session.stage === "full" && now - session.lastSeenAt > FULL_IDLE_TIMEOUT_MS;
  if (now >= session.expiresAt || idle) {
    await run("DELETE FROM sessions WHERE id_hash = ?", session.idHash);
    return null;
  }
  const user = await findUserById(session.userId);
  if (!user) return null;
  if (user.suspendedAt !== null) {
    await run("DELETE FROM sessions WHERE user_id = ?", user.id);
    return null;
  }
  if (now - session.lastSeenAt > MINUTE) {
    await run("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", now, session.idHash);
  }
  return { session, user };
}

/** Stores a single-use WebAuthn challenge on the session. */
export async function setChallenge(session: Session, challenge: string, now = Date.now()) {
  await run(
    "UPDATE sessions SET challenge = ?, challenge_expires_at = ? WHERE id_hash = ?",
    challenge,
    now + CHALLENGE_LIFETIME_MS,
    session.idHash,
  );
}

/** Returns the pending challenge (if still valid) and clears it so it can't be reused. */
export async function takeChallenge(session: Session, now = Date.now()): Promise<string | null> {
  await run("UPDATE sessions SET challenge = NULL, challenge_expires_at = NULL WHERE id_hash = ?", session.idHash);
  if (!session.challenge || !session.challengeExpiresAt || now > session.challengeExpiresAt) return null;
  return session.challenge;
}

/** Counts a failed second-factor attempt. Returns true when the session has been locked out (deleted). */
export async function recordMfaFailure(session: Session): Promise<boolean> {
  const row = await first<{ failed_mfa_attempts: number }>(
    "UPDATE sessions SET failed_mfa_attempts = failed_mfa_attempts + 1 WHERE id_hash = ? RETURNING failed_mfa_attempts",
    session.idHash,
  );
  if ((row?.failed_mfa_attempts ?? MAX_MFA_FAILURES) >= MAX_MFA_FAILURES) {
    await run("DELETE FROM sessions WHERE id_hash = ?", session.idHash);
    return true;
  }
  return false;
}

/** Admin changes and adding sign-in methods need a second factor checked within this long. */
export const VERIFY_WINDOW_MS = 15 * MINUTE;

export function recentlyVerified(session: Session, now = Date.now()): boolean {
  return session.verifiedAt !== null && now - session.verifiedAt < VERIFY_WINDOW_MS;
}

/** Records a fresh second-factor check, for actions that need one (admin changes). */
export async function markVerified(session: Session, now = Date.now()) {
  await run("UPDATE sessions SET verified_at = ? WHERE id_hash = ?", now, session.idHash);
}

/** Live sessions for an account, newest activity first. */
export async function listSessions(userId: number, now = Date.now()): Promise<Session[]> {
  const rows = await all<SessionRow>(
    "SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
    userId,
    now,
  );
  return rows.map(toSession);
}
