import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { parseAppSecret } from "./app-secret";

export const APP_NAME = "OnlyJewishGirls";

/** Bindings and secrets from wrangler.jsonc / the Worker's settings (or .dev.vars locally). */
export function cfEnv(): CloudflareEnv {
  return getCloudflareContext().env;
}

let secret: Buffer | undefined;

/**
 * 32-byte key that encrypts authenticator-app secrets at rest. Set it as the
 * APP_SECRET secret on the Worker; `npm run dev` creates one in .dev.vars.
 */
export function appSecret(): Buffer {
  secret ??= parseAppSecret(cfEnv().APP_SECRET);
  return secret;
}

/**
 * The WebAuthn relying-party ID for a host. Passkeys only work on the domain
 * they were made on; setting WEBAUTHN_RP_ID to the parent domain lets
 * onlyjewishgirls.com and www.onlyjewishgirls.com share them.
 */
export function rpIdFor(hostname: string): string {
  const configured = cfEnv().WEBAUTHN_RP_ID;
  return configured && (hostname === configured || hostname.endsWith(`.${configured}`)) ? configured : hostname;
}

export function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/** Host of the current request; usable in server components and route handlers. */
export async function requestHost(): Promise<string> {
  return (await headers()).get("host") ?? "";
}
