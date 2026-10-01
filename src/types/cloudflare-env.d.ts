// Optional settings that aren't in wrangler.jsonc, so `wrangler types` doesn't know about them.
interface CloudflareEnv {
  WEBAUTHN_RP_ID?: string;
  /** Resend API key (secret) for password-reset emails. */
  EMAIL_API_KEY?: string;
  /** Sender, e.g. "OnlyJewishGirls <no-reply@onlyjewishgirls.com>". */
  EMAIL_FROM?: string;
  /** Base URL for links in emails, e.g. "https://onlyjewishgirls.com". Defaults to the request's origin. */
  PUBLIC_ORIGIN?: string;
}
