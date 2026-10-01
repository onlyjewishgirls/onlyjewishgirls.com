import "server-only";
import { cookies } from "next/headers";
import { config } from "./config";
import { randomToken, sha256 } from "./crypto";
import { db } from "./db";
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

/** __Host- cookies can't be set by subdomains or over plain HTTP. */
export const SESSION_COOKIE = config.secureCookies ? "__Host-ojg_session" : "ojg_session";

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
  };
}

/**
 * Starts a fresh session (new random ID every time the privilege level
 * changes, so a stolen pre-login cookie is worthless). Route handlers only.
 */
export async function startSession(userId: number, stage: SessionStage, now = Date.now()): Promise<void> {
  await endSession();
  db().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  const token = randomToken();
  const expiresAt = now + (stage === "full" ? FULL_LIFETIME_MS : PENDING_LIFETIME_MS);
  db()
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sha256(token), userId, stage, now, now, expiresAt);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

/** Route handlers only. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    db().prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
    store.delete(SESSION_COOKIE);
  }
}

export interface AuthContext {
  session: Session;
  user: User;
}

export async function getAuth(now = Date.now()): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const conn = db();
  const row = conn.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(sha256(token)) as SessionRow | undefined;
  if (!row) return null;
  const session = toSession(row);
  const idle = session.stage === "full" && now - session.lastSeenAt > FULL_IDLE_TIMEOUT_MS;
  if (now >= session.expiresAt || idle) {
    conn.prepare("DELETE FROM sessions WHERE id_hash = ?").run(session.idHash);
    return null;
  }
  const user = findUserById(session.userId);
  if (!user) return null;
  if (now - session.lastSeenAt > MINUTE) {
    conn.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, session.idHash);
  }
  return { session, user };
}

/** Stores a single-use WebAuthn challenge on the session. */
export function setChallenge(session: Session, challenge: string, now = Date.now()) {
  db()
    .prepare("UPDATE sessions SET challenge = ?, challenge_expires_at = ? WHERE id_hash = ?")
    .run(challenge, now + CHALLENGE_LIFETIME_MS, session.idHash);
}

/** Returns the pending challenge (if still valid) and clears it so it can't be reused. */
export function takeChallenge(session: Session, now = Date.now()): string | null {
  db().prepare("UPDATE sessions SET challenge = NULL, challenge_expires_at = NULL WHERE id_hash = ?").run(session.idHash);
  if (!session.challenge || !session.challengeExpiresAt || now > session.challengeExpiresAt) return null;
  return session.challenge;
}

/** Counts a failed second-factor attempt. Returns true when the session has been locked out (deleted). */
export function recordMfaFailure(session: Session): boolean {
  const conn = db();
  conn.prepare("UPDATE sessions SET failed_mfa_attempts = failed_mfa_attempts + 1 WHERE id_hash = ?").run(session.idHash);
  if (session.failedMfaAttempts + 1 >= MAX_MFA_FAILURES) {
    conn.prepare("DELETE FROM sessions WHERE id_hash = ?").run(session.idHash);
    return true;
  }
  return false;
}
