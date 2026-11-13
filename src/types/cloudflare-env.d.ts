// Optional settings that aren't in wrangler.jsonc, so `wrangler types` doesn't know about them.
interface CloudflareEnv {
  WEBAUTHN_RP_ID?: string;
  /** Resend API key (secret): the fallback when Plunk fails. */
  EMAIL_API_KEY?: string;
  /** Plunk secret key (sk_…): the primary mail provider. Alone, it's a complete mail set-up. */
  PLUNK_API_KEY?: string;
  /** Optional override for Plunk's send endpoint (default https://next-api.useplunk.com/v1/send). */
  PLUNK_API_URL?: string;
  /** Sender for account mail; defaults to "OnlyJewishGirls <no-reply@onlyjewishgirls.com>". */
  EMAIL_FROM?: string;
  /** Base URL for links in emails, e.g. "https://onlyjewishgirls.com". Defaults to the request's origin. */
  PUBLIC_ORIGIN?: string;
  /** Older names for the alert routing, read as a fallback (PORTAL-STANDARD §6). */
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
  /**
   * The CAPTCHA wall (PORTAL-STANDARD §10, gate-kit/). TURNSTILE_SITE_KEY (a plain variable) and
   * TURNSTILE_SECRET_KEY (a secret) come from wrangler.jsonc / .dev.vars via `npm run cf-typegen`;
   * TURNSTILE_SECRET is the kit's accepted alias for the secret.
   */
  TURNSTILE_SECRET?: string;
  /** Optional, 32+ characters: signs CAPTCHA passes instead of a key derived from the Turnstile secret. Rotate it to end every pass. */
  GATE_SECRET?: string;
  /** "off" is the CAPTCHA wall's break-glass switch (the console shows it red and an alert goes out daily). Normally absent. */
  GATE_MODE?: string;
}
