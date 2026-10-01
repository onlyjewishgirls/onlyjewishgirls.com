import "server-only";
import { normalizePassword } from "@/lib/password/policy";

/**
 * PBKDF2-HMAC-SHA256 with 100,000 iterations, via WebCrypto (native in Workers).
 * 100,000 is the most Workers' WebCrypto allows in one call, and it costs about
 * 15 ms of CPU, which keeps sign-in within the Workers Free plan. The password
 * rules (16+ characters, no words, no sequences) carry most of the weight against
 * guessing.
 */
const SCHEME = "pbkdf2-sha256";
const ITERATIONS = 100_000;
const KEY_BITS = 256;

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalizePassword(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Format: pbkdf2-sha256$iterations$salt$hash, so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return [SCHEME, ITERATIONS, Buffer.from(salt).toString("base64url"), Buffer.from(hash).toString("base64url")].join(
    "$",
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== SCHEME || !salt || !hash) return false;
  const expected = new Uint8Array(Buffer.from(hash, "base64url"));
  const actual = await derive(password, new Uint8Array(Buffer.from(salt, "base64url")), Number(iterations));
  return constantTimeEqual(actual, expected);
}

/** Spend the same time as a real check so response timing doesn't reveal which accounts exist. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), ITERATIONS);
}
