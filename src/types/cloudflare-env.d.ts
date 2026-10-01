// Optional settings that aren't in wrangler.jsonc, so `wrangler types` doesn't know about them.
interface CloudflareEnv {
  WEBAUTHN_RP_ID?: string;
}
