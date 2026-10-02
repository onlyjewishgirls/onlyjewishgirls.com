import { createHash } from "node:crypto";

/**
 * A problem with how the site is set up (not with the request). Its message is
 * safe to show, so the site owner can see what to fix without digging through logs.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Shorter values are too easy to guess to protect anything. */
export const MIN_APP_SECRET_LENGTH = 16;

const HEX_KEY = /^[0-9a-f]{64}$/i;
/** Exactly 32 bytes as base64 or base64url (43 characters, plus optional padding). */
const BASE64_KEY = /^(?:[A-Za-z0-9+/]{43}|[A-Za-z0-9_-]{43})=?$/;

/**
 * Turns the APP_SECRET setting into the 32-byte AES key.
 *
 * A 32-byte key in hex or base64 (`openssl rand -base64 32`) is used as is.
 * Anything else at least 16 characters long, such as a UUID or a password
 * manager's random password, is hashed into a key, so pasting a different
 * kind of random string doesn't break the site. Surrounding spaces, line
 * breaks and quotes from copy-pasting are ignored.
 */
export function parseAppSecret(raw: string | undefined): Buffer {
  const value = (raw ?? "")
    .trim()
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .trim();
  if (!value) {
    throw new ConfigError(
      "APP_SECRET isn't set. Add it under Workers & Pages → onlyjewishgirlsdotcom → Settings → Variables and Secrets.",
    );
  }
  if (HEX_KEY.test(value)) return Buffer.from(value, "hex");
  if (BASE64_KEY.test(value)) return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (value.length < MIN_APP_SECRET_LENGTH) {
    throw new ConfigError(
      `APP_SECRET is too short (${value.length} characters). Use at least ${MIN_APP_SECRET_LENGTH} random characters.`,
    );
  }
  return createHash("sha256").update(`onlyjewishgirls app secret v1\0${value}`).digest();
}
