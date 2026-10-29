// Optional settings that aren't in wrangler.jsonc, so `wrangler types` doesn't know about them.
interface CloudflareEnv {
  WEBAUTHN_RP_ID?: string;
  /** Resend API key (secret) for password-reset emails. */
  EMAIL_API_KEY?: string;
  /** Plunk secret key (sk_…): the backup to Resend for the same emails, or the primary per EMAIL_PRIMARY. */
  PLUNK_API_KEY?: string;
  /** "resend" (default) or "plunk": which email provider is tried first. */
  EMAIL_PRIMARY?: string;
  /** Sender, e.g. "OnlyJewishGirls <no-reply@onlyjewishgirls.com>". */
  EMAIL_FROM?: string;
  /** How long the streak leaderboard is reused before it's read again, in seconds (default 60; 0 for tests). */
  LEADERBOARD_CACHE_SECONDS?: string;
  /** Base URL for links in emails, e.g. "https://onlyjewishgirls.com". Defaults to the request's origin. */
  PUBLIC_ORIGIN?: string;
}
