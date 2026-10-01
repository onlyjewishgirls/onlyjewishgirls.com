import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const origin = (process.env.APP_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");

export const config = {
  appName: "OnlyJewishGirls",
  /** Exact origin the site is served from. Used for WebAuthn and CSRF checks. */
  origin,
  /** WebAuthn relying-party ID: the registrable domain, e.g. "onlyjewishgirls.com". */
  rpId: process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname,
  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, "app.db"),
  secureCookies: origin.startsWith("https://"),
  /**
   * How many proxies (load balancer, CDN…) sit in front of the app. The client
   * IP is read that many entries from the right of X-Forwarded-For, so values a
   * client sends itself are ignored. 1 fits a single nginx/Caddy/Vercel/Fly hop.
   */
  trustedProxyHops: Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1),
  isProduction: process.env.NODE_ENV === "production",
};

let secret: Buffer | undefined;

/**
 * 32-byte key used to encrypt authenticator-app secrets at rest.
 * Set APP_SECRET in production (e.g. `openssl rand -base64 32`). In development
 * a key is generated once and kept in .data/app-secret.
 */
export function appSecret(): Buffer {
  if (secret) return secret;
  const fromEnv = process.env.APP_SECRET;
  if (fromEnv) {
    const decoded = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, "hex") : Buffer.from(fromEnv, "base64");
    if (decoded.length !== 32) throw new Error("APP_SECRET must be 32 bytes, base64 or hex encoded");
    secret = decoded;
    return secret;
  }
  if (config.isProduction) throw new Error("APP_SECRET must be set in production");

  const file = path.join(config.dataDir, "app-secret");
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  secret = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  return secret;
}
