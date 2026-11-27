// Types for gate.mjs (Gate kit, PORTAL-STANDARD §10).
// gate.d.mts is a byte-for-byte copy: TypeScript looks for ".d.mts" next to a
// ".mjs" import, and for ".d.ts" otherwise. Keep both; never edit one alone.
// Written for `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

export declare const GATE_KIT_VERSION: string;
export declare const VERIFY_PATH: '/__gate/verify';
export declare const PASS_COOKIE: '__Host-gate_pass';
export declare const TURNSTILE_ORIGIN: 'https://challenges.cloudflare.com';
export declare const TURNSTILE_API: string;
export declare const SITEVERIFY_URL: string;
export declare const GATE_ACTION: 'gate';
export declare const PASS_HOURS: { readonly default: 12; readonly min: 1; readonly max: 168 };
export declare const MSG_NOT_CONFIGURED: string;
/** The 503 text when Cloudflare's always-pass test keys are used outside local development. */
export declare const MSG_TEST_KEYS: string;

/** The deploy-level variables the gate reads. Your Env type must declare the ones it uses. */
export interface GateEnv {
  /** Public Turnstile site key (wrangler `vars`). */
  TURNSTILE_SITE_KEY?: string | undefined;
  /** Turnstile secret (a secret, never in `vars`). */
  TURNSTILE_SECRET_KEY?: string | undefined;
  /** Older name for TURNSTILE_SECRET_KEY, still accepted. */
  TURNSTILE_SECRET?: string | undefined;
  /** Optional dedicated HMAC secret for passes, 32+ characters. */
  GATE_SECRET?: string | undefined;
  /** "off" is the break-glass switch. Anything else (or unset) means on. */
  GATE_MODE?: string | undefined;
}

/** Workers' ExecutionContext satisfies this. */
export interface GateExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type GateEventType =
  | 'challenge_served' // challenge page shown to a browser navigation without a pass
  | 'blocked'          // 403 captcha_required JSON for anything else without a pass
  | 'verify_ok'        // a pass was issued
  | 'verify_failed'    // POST /__gate/verify refused
  | 'exempted'         // the exempt hook named a machine client
  | 'misconfigured'    // 503: keys missing, test keys outside local dev, weak GATE_SECRET (throttled)
  | 'gate_off';        // GATE_MODE="off" let a request through (throttled)

export type GateStatName = GateEventType | 'passed';

export type GatePassFailure =
  | 'no_pass' | 'malformed' | 'bad_signature' | 'host_mismatch' | 'ip_changed'
  | 'ua_changed' | 'not_yet_valid' | 'expired';

export type GateVerifyFailure =
  | 'cross_origin' | 'bad_request' | 'missing_token' | 'malformed_token' | 'test_token'
  | 'siteverify_http' | 'network_error' | 'rejected' | 'hostname_mismatch' | 'action_mismatch';

export interface GateEventDetail {
  ip: string;
  host: string;
  path: string;
  method: string;
  country: string | null;
  ua: string;
  /** UTC hour bucket, e.g. "2026-11-12T22". */
  hour: string;
  /** challenge_served / blocked: why there was no pass. verify_failed: why it was refused. misconfigured: the problem code. */
  reason?: GatePassFailure | GateVerifyFailure | 'not_configured' | 'test_keys' | 'weak_gate_secret' | undefined;
  /** exempted: the name the exempt hook returned. */
  exemption?: string | undefined;
  /** verify_failed (rejected): Turnstile error codes. */
  codes?: string[] | undefined;
  /** verify_ok: lifetime of the pass in hours, and its expiry (epoch seconds). */
  hours?: number | undefined;
  exp?: number | undefined;
  /** verify_failed (hostname_mismatch / action_mismatch / siteverify_http). */
  hostname?: string | undefined;
  action?: string | undefined;
  status?: number | undefined;
}

export interface GateStatsRow {
  /** UTC hour bucket, e.g. "2026-11-12T22". */
  hour: string;
  event: GateStatName;
  count: number;
}

export interface GateStats {
  /** ISO time this isolate/process handled its first request (on Workers the clock reads 0 at module scope). */
  since: string;
  totals: Partial<Record<GateStatName, number>>;
  pending: number;
}

type Awaitable<T> = T | Promise<T>;

export interface GateOptions<E extends GateEnv = GateEnv> {
  /** Shown on the challenge page: "Checking that you're human before loading <siteName>." */
  siteName: string;
  /** Shown above the name. Defaults to the request's hostname. */
  siteDomain?: string | undefined;
  /** Site settings. Asked for "captcha_pass_hours" (default 12, clamped 1-168) when a pass is issued. */
  getSetting?: ((key: 'captcha_pass_hours' | (string & {}), env: E) => Awaitable<unknown>) | undefined;
  /** Machine clients only. Return the exemption's name (e.g. "kidmonitor") to let the request through. */
  exempt?: ((request: Request, url: URL, env: E) => Awaitable<string | null | undefined | false>) | undefined;
  /** Counters only: never alert, audit or blacklist from here (PORTAL-STANDARD §10, quiet by design). */
  onEvent?: ((type: GateEventType, detail: GateEventDetail, env: E) => Awaitable<unknown>) | undefined;
  /** Batched counts per UTC hour, at most once per statsFlushSeconds per isolate. */
  onStats?: ((rows: GateStatsRow[], env: E) => Awaitable<unknown>) | undefined;
  /** Default 60. */
  statsFlushSeconds?: number | undefined;
  /** Clock, epoch milliseconds. For tests. */
  now?: (() => number) | undefined;
  /** fetch used for siteverify. For tests. */
  fetch?: ((input: string, init: RequestInit) => Promise<Response>) | undefined;
}

export interface Gate<E extends GateEnv = GateEnv> {
  /**
   * Run the wall. Resolves to a Response to return as-is (challenge page,
   * 403 JSON, 503, or the verify endpoint's answer), or null when the request
   * may continue to the site (valid pass, exemption, or GATE_MODE="off").
   */
  handle(request: Request, env: E, ctx?: GateExecutionContext | undefined): Promise<Response | null>;
  /**
   * Vary: Cookie + private Cache-Control on a response served on a pass, and
   * no CDN-only cache headers (see isSharedCacheHeader). Leaves a 101 alone.
   */
  decorate(response: Response): Response;
  /**
   * The exemption name when handle() let this exact Request object through
   * only because the exempt hook matched it (no pass), else null. Answer such
   * a request from the machine-client handler alone; anything it doesn't
   * serve gets a bare 404 (no detection, alerts, 404 page or assets fallback).
   */
  exemptionOf(request: Request): string | null;
  /** handle(), then next() decorated when it passed. */
  run(
    request: Request,
    env: E,
    ctx: GateExecutionContext | undefined,
    next: () => Awaitable<Response>,
  ): Promise<Response>;
  /** In-memory counts for this isolate/process since it started. */
  stats(): GateStats;
  /** Hand pending counts to onStats now. */
  flushStats(env: E, ctx?: GateExecutionContext | undefined): Promise<void>;
  readonly siteName: string;
}

export declare function createGate<E extends GateEnv = GateEnv>(options: GateOptions<E>): Gate<E>;

export interface GateStatus {
  state: 'on' | 'off' | 'not_configured' | 'misconfigured';
  /** true only when the wall is on and correctly configured. Show red otherwise. */
  ok: boolean;
  label: string;
  detail: string;
}
/** The console posture item, from the deploy's variables alone. */
export declare function gateStatus(env: GateEnv | object | null | undefined): GateStatus;

/* Low-level helpers, exported for tests and for sites that need them. */

export interface PassClaims {
  host: string;
  ip: string;
  uah: string;
  iat: number;
  exp: number;
}
export type PassCheck =
  | { ok: true; claims: PassClaims & { v: 1 } }
  | { ok: false; reason: GatePassFailure };

/**
 * The HMAC key derivePassKey() returns: a Web Crypto CryptoKey, declared
 * structurally so the types need neither the DOM lib nor Workers' types
 * (a Node-only project with types: ["node"] has no global CryptoKey).
 */
export type GatePassKey = object & { readonly algorithm: unknown; readonly type: string };

export declare function canonicalIp(raw: string | null | undefined): string;
/** Empty, unparseable, loopback, RFC 1918, CGNAT, link-local, multicast/reserved or IPv6 ULA: not one visitor's address. */
export declare function isPrivateAddress(raw: string | null | undefined): boolean;
/** localhost, *.localhost, 127.0.0.1 or [::1], with or without a port. */
export declare function isLoopbackHost(host: string | null | undefined): boolean;
/** CDN-Cache-Control, <vendor>-CDN-Cache-Control, Surrogate-Control, X-Accel-Expires (case-insensitive). */
export declare function isSharedCacheHeader(name: string): boolean;
export declare function safeReturnPath(raw: unknown): string;
export declare function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
export declare function isTestSiteKey(key: string | null | undefined): boolean;
export declare function isTestSecret(key: string | null | undefined): boolean;
export declare function isTestToken(token: string | null | undefined): boolean;
export declare function derivePassKey(material: string): Promise<GatePassKey>;
export declare function uaHash(userAgent: string | null | undefined): Promise<string>;
export declare function signPass(key: GatePassKey, claims: PassClaims): Promise<string>;
export declare function verifyPass(
  value: string,
  key: GatePassKey,
  expect: { host: string; ip: string; uah: string },
  nowSec: number,
): Promise<PassCheck>;
export declare function readCookies(header: string | null | undefined, name: string): string[];
export declare function privateCacheControl(value: string | null | undefined): string;
export declare function escapeHtml(s: unknown): string;
export declare function challengeCsp(nonce: string): string;
export declare function renderChallengePage(page: {
  siteName: string;
  siteDomain: string;
  siteKey: string;
  nonce: string;
  returnPath?: string | undefined;
  error?: string | undefined;
}): string;
