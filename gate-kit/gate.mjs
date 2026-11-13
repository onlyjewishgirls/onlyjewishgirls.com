/* ==========================================================================
   Gate kit: the CAPTCHA wall in front of everything (PORTAL-STANDARD §10).

   One ES module, no dependencies, Web Crypto only. Runs unchanged on
   Cloudflare Workers (JS or TS), Node >= 18 (through gate-node.mjs) and the
   OpenNext worker of a Next.js app. Vendor it into a repo as-is; do not edit
   it per site. Everything a site needs to say goes through createGate().

     const gate = createGate({ siteName: 'Example' });
     // in fetch(): deny list first, then
     const blocked = await gate.handle(request, env, ctx);
     if (blocked) return blocked;              // challenge, 403 JSON, 503, verify
     return gate.decorate(await site(request)); // passed: never shared-cacheable

   Nothing in here touches the site's data. The site hands in its settings,
   machine-client exemptions and counters through the hooks.
   ========================================================================== */

export const GATE_KIT_VERSION = '1.2.0';
export const VERIFY_PATH = '/__gate/verify';
export const PASS_COOKIE = '__Host-gate_pass';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_API = TURNSTILE_ORIGIN + '/turnstile/v0/api.js';
export const SITEVERIFY_URL = TURNSTILE_ORIGIN + '/turnstile/v0/siteverify';
export const GATE_ACTION = 'gate';
export const PASS_HOURS = Object.freeze({ default: 12, min: 1, max: 168 });

export const MSG_NOT_CONFIGURED =
  'Not available: CAPTCHA is not configured (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY).';
export const MSG_TEST_KEYS =
  "Not available: CAPTCHA is misconfigured (Cloudflare's always-pass test keys are refused outside local development).";
const MSG_GATE_FAILED = 'Not available: the CAPTCHA gate failed.';
const MSG_WEAK_SECRET =
  'Not available: CAPTCHA is misconfigured (GATE_SECRET is set but shorter than 32 characters).';

const PASS_VERSION = 1;
const CLOCK_SKEW_S = 120;          // tolerated future iat (edge clocks differ a little)
const MAX_COOKIE_LEN = 1024;       // a real pass is ~300 bytes
const MAX_TOKEN_LEN = 2048;        // Turnstile tokens are at most 2048 chars
const MAX_BODY = 12 * 1024;        // token + return path + field names
const MAX_RETURN_LEN = 2048;
const SITEVERIFY_TIMEOUT_MS = 10000;
const QUIET_EVENT_MS = 10 * 60 * 1000;   // misconfigured / gate_off: once per 10 min per isolate
const MAX_PENDING_STATS = 512;

const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
// Cloudflare's documented test keys: 1x/2x/3x + zeros + two letters.
// Real keys start "0x4AAAAAAA", so this never matches one.
const TEST_SITE_KEY = /^[1-3]x0{20}[A-F]{2}$/i;
const TEST_SECRET = /^[1-3]x0{31}[A-F]{2}$/i;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ small -- */

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('gate-kit: Web Crypto (globalThis.crypto.subtle) is not available');
  return c.subtle;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time byte comparison. Lengths are not secret (a pass MAC is always 32 bytes). */
export function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function randomToken(bytes = 16) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return b64url(a);
}

function hourBucket(ms) {
  return new Date(ms).toISOString().slice(0, 13); // 2026-11-12T22 (UTC)
}

/* ------------------------------------------------------------- addresses -- */

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function parseIPv6(s) {
  let text = s;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text = text.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const dbl = text.indexOf('::');
  if (dbl !== text.lastIndexOf('::')) return null;
  const split = (part) => (part === '' ? [] : part.split(':'));
  const head = split(dbl >= 0 ? text.slice(0, dbl) : text);
  const rest = dbl >= 0 ? split(text.slice(dbl + 2)) : [];
  const groups = head.concat(rest);
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  if (dbl >= 0 ? groups.length > 7 : groups.length !== 8) return null;
  const words = head.map((g) => parseInt(g, 16));
  for (let i = groups.length; i < 8; i++) words.push(0);
  return words.concat(rest.map((g) => parseInt(g, 16)));
}

/**
 * One spelling per address, so a pass bound to "2001:DB8:0:0::1" still
 * matches "2001:db8::1": lowercase, brackets and zone id dropped, IPv6
 * compressed per RFC 5952, and IPv4-mapped IPv6 (::ffff:1.2.3.4) unwrapped
 * to plain IPv4. Anything unparseable is compared verbatim.
 */
export function canonicalIp(raw) {
  let s = str(raw).toLowerCase();
  if (!s) return '';
  if (s.length > 100) s = s.slice(0, 100);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = parseIPv4(s);
  if (v4) return v4.join('.');
  if (!s.includes(':')) return s;
  const w = parseIPv6(s);
  if (!w) return s;
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
    return [w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255].join('.');
  }
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (w[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = w.map((n) => n.toString(16));
  if (best < 0) return hex.join(':');
  return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLen).join(':');
}

function isLoopbackIp(ip) {
  return ip === '::1' || /^127\./.test(ip);
}

/** A loopback host name: localhost, *.localhost, 127.0.0.1 or [::1] (with or without a port). */
export function isLoopbackHost(host) {
  let h = str(host).toLowerCase();
  if (h.startsWith('[')) h = h.slice(0, h.indexOf(']') + 1);
  else h = h.replace(/:\d{1,5}$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
}

function isLocalDev(url, ip) {
  // The host alone is spoofable on a self-hosted Node server; the client
  // address (put in CF-Connecting-IP by gate-node.mjs, which also requires
  // an explicit local-dev opt-in there) is not. No address is never local.
  return isLoopbackHost(url.hostname) && isLoopbackIp(ip);
}

/**
 * True for an address that can't stand for one visitor: empty or
 * unparseable, unspecified, loopback, RFC 1918, CGNAT (100.64/10),
 * link-local, multicast/reserved, IPv6 ULA (fc00::/7). A reverse proxy, a
 * container bridge or a Unix socket shows up as one of these, and binding
 * passes to it would let one solve unlock every visitor behind it.
 */
export function isPrivateAddress(raw) {
  const ip = canonicalIp(raw);
  if (!ip) return true;
  const v4 = parseIPv4(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  const w = ip.includes(':') ? parseIPv6(ip) : null;
  if (!w) return true;
  if (w.every((n) => n === 0)) return true;                          // ::
  if (w.slice(0, 7).every((n) => n === 0) && w[7] === 1) return true; // ::1
  const top = w[0];
  return (top & 0xfe00) === 0xfc00     // fc00::/7 unique local
    || (top & 0xffc0) === 0xfe80       // fe80::/10 link-local
    || (top & 0xff00) === 0xff00;      // ff00::/8 multicast
}

/* -------------------------------------------------------------- test keys -- */

export function isTestSiteKey(k) { return TEST_SITE_KEY.test(str(k)); }
export function isTestSecret(k) { return TEST_SECRET.test(str(k)); }
export function isTestToken(t) {
  const s = str(t);
  return s === DUMMY_TOKEN || TEST_SITE_KEY.test(s) || TEST_SECRET.test(s);
}

/* ------------------------------------------------------------ return URL -- */

/**
 * The only places the verify endpoint will send a browser: a same-origin
 * path. "//evil.com", "/\evil.com", "https://evil.com", "javascript:..." and
 * anything with a control character or backslash (the URL parser drops tabs
 * and newlines, which would turn "/\t/evil.com" into "//evil.com") go to "/".
 */
export function safeReturnPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_LEN) return '/';
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '/';
  let u;
  try {
    u = new URL(raw, 'https://gate.invalid');
  } catch {
    return '/';
  }
  if (u.origin !== 'https://gate.invalid') return '/';
  const out = u.pathname + u.search + u.hash;
  if (u.pathname === VERIFY_PATH || out.length > MAX_RETURN_LEN || out.startsWith('//')) return '/';
  return out;
}

/* -------------------------------------------------------------- the pass -- */

const keyCache = new Map();

/**
 * The HMAC key for passes: GATE_SECRET when set, else derived from the
 * Turnstile secret. Either way it goes through one HMAC with a fixed label,
 * so the raw secret is never the MAC key and a pass can never be confused
 * with anything else a site signs with the same secret.
 */
export async function derivePassKey(material) {
  const m = str(material);
  if (!m) throw new Error('gate-kit: no key material for the pass');
  const hit = keyCache.get(m);
  if (hit) return hit;
  const s = subtle();
  const base = await s.importKey('raw', enc.encode(m), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await s.sign('HMAC', base, enc.encode('gate-kit/pass-key/v1'));
  const key = await s.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  if (keyCache.size >= 8) keyCache.clear();
  keyCache.set(m, key);
  return key;
}

async function mac(key, text) {
  return new Uint8Array(await subtle().sign('HMAC', key, enc.encode(text)));
}

export async function uaHash(ua) {
  const d = await subtle().digest('SHA-256', enc.encode(String(ua || '').slice(0, 1024)));
  return b64url(new Uint8Array(d)).slice(0, 22);
}

/** Sign a pass payload {v, host, ip, uah, iat, exp} into the cookie value "v1.<payload>.<mac>". */
export async function signPass(key, claims) {
  const body = b64url(enc.encode(JSON.stringify({
    v: PASS_VERSION, host: claims.host, ip: claims.ip, uah: claims.uah, iat: claims.iat, exp: claims.exp,
  })));
  return 'v1.' + body + '.' + b64url(await mac(key, 'v1.' + body));
}

/**
 * Check a pass cookie value. The MAC is checked first, in constant time, and
 * only then are the claims read, so nothing about them can be probed without
 * a valid signature. Returns { ok: true, claims } or { ok: false, reason }.
 */
export async function verifyPass(value, key, expect, nowSec) {
  if (typeof value !== 'string' || value.length > MAX_COOKIE_LEN) return { ok: false, reason: 'malformed' };
  const m = /^v1\.([A-Za-z0-9_-]{16,900})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return { ok: false, reason: 'malformed' };
  const given = fromB64url(m[2]);
  const want = await mac(key, 'v1.' + m[1]);
  if (!timingSafeEqual(want, given)) return { ok: false, reason: 'bad_signature' };
  let c;
  try {
    c = JSON.parse(dec.decode(fromB64url(m[1]) || new Uint8Array()));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!c || c.v !== PASS_VERSION || typeof c.host !== 'string' || typeof c.ip !== 'string' || typeof c.uah !== 'string'
    || !Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return { ok: false, reason: 'malformed' };
  if (c.exp - c.iat > PASS_HOURS.max * 3600 + CLOCK_SKEW_S || c.exp <= c.iat) return { ok: false, reason: 'malformed' };
  if (c.host !== expect.host) return { ok: false, reason: 'host_mismatch' };
  if (c.ip !== expect.ip) return { ok: false, reason: 'ip_changed' };
  if (c.uah !== expect.uah) return { ok: false, reason: 'ua_changed' };
  if (c.iat > nowSec + CLOCK_SKEW_S) return { ok: false, reason: 'not_yet_valid' };
  if (c.exp <= nowSec) return { ok: false, reason: 'expired' };
  return { ok: true, claims: c };
}

/** All values of one cookie name (at most 4), without trusting the header's shape. */
export function readCookies(header, name) {
  const out = [];
  if (typeof header !== 'string' || !header) return out;
  const h = header.length > 32768 ? header.slice(0, 32768) : header;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    out.push(part.slice(i + 1).trim().replace(/^"(.*)"$/, '$1'));
    if (out.length >= 4) break;
  }
  return out;
}

/* ---------------------------------------------------------- the responses -- */

function baseHeaders(extra) {
  const h = new Headers({
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function textResponse(status, text, method) {
  return new Response(method === 'HEAD' ? null : text, {
    status,
    headers: baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}

function jsonResponse(status, obj, method) {
  return new Response(method === 'HEAD' ? null : JSON.stringify(obj), {
    status,
    headers: baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

export function challengeCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `style-src 'nonce-${nonce}'`,
    `connect-src 'self' ${TURNSTILE_ORIGIN}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const CHALLENGE_CSS = `
:root{
  --cx-bg:#f6f8fb;--cx-panel:#fff;--cx-text:#182230;--cx-strong:#475467;--cx-muted:#667085;
  --cx-line:#e4e7ec;--cx-line-strong:#d0d5dd;--cx-field:#fff;--cx-primary:#175cd3;--cx-primary-hover:#1849a9;
  --cx-primary-soft:#eff8ff;--cx-on-primary:#fff;--cx-danger:#b42318;--cx-danger-bg:#fef3f2;
  --cx-warn:#b54708;--cx-warn-bg:#fff6ed;--cx-shadow:0 1px 2px rgba(16,24,40,.05),0 12px 32px rgba(16,24,40,.06);
  --cx-font-display:'Playfair Display',Georgia,'Times New Roman',serif;
  --cx-font-body:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --cx-bg:#09090b;--cx-panel:#141419;--cx-text:#ededf0;--cx-strong:#c9c9d4;--cx-muted:#a5a5b0;
  --cx-line:#26262e;--cx-line-strong:#3a3a45;--cx-field:#101014;--cx-primary:#4d92f5;--cx-primary-hover:#6ea6f7;
  --cx-primary-soft:#14213a;--cx-on-primary:#06121f;--cx-danger:#f07a85;--cx-danger-bg:#2c1316;
  --cx-warn:#d9a441;--cx-warn-bg:#2a2010;--cx-shadow:none;color-scheme:dark;
}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;
  padding:32px 16px 48px;background:var(--cx-bg);color:var(--cx-text);font:15px/1.55 var(--cx-font-body);
  -webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
.g-card{width:100%;max-width:440px;background:var(--cx-panel);border:1px solid var(--cx-line);border-radius:14px;
  box-shadow:var(--cx-shadow);padding:32px 32px 28px}
.g-mark{width:44px;height:44px;border-radius:12px;background:var(--cx-primary-soft);color:var(--cx-primary);
  display:flex;align-items:center;justify-content:center;margin:0 0 20px}
.g-mark svg{width:24px;height:24px}
.g-domain{margin:0 0 6px;font-size:11.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--cx-muted)}
h1{font-family:var(--cx-font-display);font-weight:700;font-size:30px;line-height:1.18;letter-spacing:-.01em;margin:0 0 10px}
.g-line{margin:0 0 24px;color:var(--cx-strong);font-size:15px}
form{margin:0}
.g-widget{display:none;min-height:65px;width:100%}
.js .g-widget{display:block}
.js .g-widget[hidden]{display:none}
.g-widget>*{max-width:100%}
.g-status{display:none;align-items:center;gap:10px;min-height:22px;margin:14px 0 0;font-size:13px;color:var(--cx-muted)}
.js .g-status{display:flex}
.g-status:empty{min-height:0;margin:0}
.g-failed .g-line{margin-bottom:4px}
.g-status.busy::before{content:"";flex:none;width:14px;height:14px;border-radius:50%;border:2px solid var(--cx-line-strong);
  border-top-color:var(--cx-primary);animation:g-spin .8s linear infinite}
@keyframes g-spin{to{transform:rotate(360deg)}}
.g-error{margin:16px 0 0;padding:14px 16px;border-radius:10px;background:var(--cx-danger-bg);color:var(--cx-danger);
  font-size:14px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}
.g-error[hidden]{display:none}
.g-error p{margin:0;flex:1 1 220px;font-weight:600}
.g-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;
  border-radius:9px;background:var(--cx-primary);color:var(--cx-on-primary);font:inherit;font-size:14px;font-weight:700;
  padding:10px 18px;min-height:44px;min-width:44px;cursor:pointer;white-space:nowrap}
.g-btn:hover{background:var(--cx-primary-hover)}
.g-btn:focus-visible{outline:2px solid var(--cx-primary);outline-offset:2px}
.g-noscript{margin:0;padding:14px 16px;border-radius:10px;background:var(--cx-warn-bg);color:var(--cx-warn);font-size:14px}
.g-noscript strong{display:block;margin-bottom:2px}
.g-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:480px){
  body{padding:20px 16px 32px}
  .g-card{padding:26px 22px 24px;border-radius:14px}
  h1{font-size:26px}
  .g-line{margin-bottom:20px}
}
@media (max-width:380px){
  body{padding:16px 10px 24px}
  .g-card{padding:22px 14px 20px}
}
@media (prefers-reduced-motion:reduce){.g-status.busy::before{animation:none}}
`;

const CHALLENGE_JS = `
(function () {
  var form = document.getElementById('gate-form');
  var box = document.getElementById('gate-widget');
  var status = document.getElementById('gate-status');
  var err = document.getElementById('gate-error');
  var errText = document.getElementById('gate-error-text');
  var retry = document.getElementById('gate-retry');
  var tokenField = document.getElementById('gate-token');
  var card = form.parentNode;
  var d = form.dataset;
  var widget = null, submitted = false, requested = false, loaded = false, timer = 0;
  function say(text, busy) { status.textContent = text; status.className = 'g-status' + (busy ? ' busy' : ''); }
  // The widget's box, or (hidden) the tight layout the failed-verify page uses.
  function showBox(on) { box.hidden = !on; card.className = on ? 'g-card' : 'g-card g-failed'; }
  function fail(text) {
    clearTimeout(timer);
    // Nothing was drawn (script blocked, timed out, render threw): don't
    // leave an empty widget-sized gap above the message.
    if (widget === null) showBox(false);
    errText.textContent = text;
    err.hidden = false;
    say('', false);
  }
  function render() {
    try {
      widget = window.turnstile.render(box, {
        sitekey: d.sitekey,
        action: 'gate',
        theme: 'auto',
        size: box.clientWidth >= 300 ? 'flexible' : 'compact',
        language: 'auto',
        'response-field': false,
        'refresh-expired': 'auto',
        callback: function (token) {
          if (submitted) return;
          submitted = true;
          err.hidden = true;
          tokenField.value = token;
          say('Verified. Loading ' + d.site + '\\u2026', true);
          form.submit();
        },
        'before-interactive-callback': function () { say('Tick the box above to continue.', false); },
        'after-interactive-callback': function () { say('Checking\\u2026', true); },
        'error-callback': function () { fail('The check ran into a problem. Please try again.'); },
        'expired-callback': function () { say('The check expired, so it is running again.', true); },
        'timeout-callback': function () {
          say('The check timed out, so it is running again.', true);
          try { window.turnstile.reset(widget); } catch (e) {}
        },
        'unsupported-callback': function () { fail('This browser cannot run the check. Please use an up-to-date browser.'); }
      });
      say('Running the check. This usually takes a few seconds.', true);
    } catch (e) {
      fail('The check could not start. Please try again.');
    }
  }
  function start() {
    err.hidden = true;
    showBox(true);
    submitted = false;
    if (widget !== null && window.turnstile) {
      say('Running the check again\\u2026', true);
      try { window.turnstile.reset(widget); } catch (e) { location.replace(d.ret); }
      return;
    }
    if (loaded) { render(); return; }
    if (requested) { location.replace(d.ret); return; }
    requested = true;
    window.__gateTurnstileReady = function () {
      loaded = true;
      clearTimeout(timer);
      // Arrived after the "taking too long" message: carry on from here.
      err.hidden = true;
      showBox(true);
      render();
    };
    var s = document.createElement('script');
    s.src = d.api;
    s.async = true;
    s.onerror = function () {
      fail('The check could not load. Make sure challenges.cloudflare.com is not blocked, then try again.');
    };
    timer = setTimeout(function () {
      if (!loaded) fail('The check is taking too long to load. Please try again.');
    }, 20000);
    say('Loading the check\\u2026', true);
    document.head.appendChild(s);
  }
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
  retry.addEventListener('click', start);
  if (d.failed === '1') {
    // A refused verify was answered at /__gate/verify; put the page's own
    // address back so a reload is a plain GET, and wait for "Try again".
    try { history.replaceState(null, '', d.ret); } catch (e) {}
    retry.focus();
  } else {
    start();
  }
})();
`;

const SHIELD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6l7-3z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/></svg>';

/**
 * The one challenge page every site shows. Pure: same inputs, same HTML.
 * `error` (optional) renders the failed-verify state with its retry button.
 */
export function renderChallengePage({ siteName, siteDomain, siteKey, nonce, returnPath = '/', error = '' }) {
  const name = escapeHtml(siteName);
  const ret = escapeHtml(safeReturnPath(returnPath));
  const n = escapeHtml(nonce);
  const failed = error ? '1' : '0';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Checking that you're human · ${name}</title>
<script nonce="${n}">document.documentElement.className='js';</script>
<style nonce="${n}">${CHALLENGE_CSS}</style>
</head>
<body>
<main class="g-card${error ? ' g-failed' : ''}" aria-labelledby="gate-title">
<div class="g-mark">${SHIELD_SVG}</div>
<p class="g-domain">${escapeHtml(siteDomain)}</p>
<h1 id="gate-title">${name}</h1>
<p class="g-line">Checking that you're human before loading ${name}.</p>
<form id="gate-form" method="post" action="${VERIFY_PATH}" data-sitekey="${escapeHtml(siteKey)}" data-site="${name}" data-ret="${ret}" data-api="${escapeHtml(TURNSTILE_API)}?render=explicit&amp;onload=__gateTurnstileReady" data-failed="${failed}">
<input type="hidden" name="return" value="${ret}">
<input type="hidden" name="token" id="gate-token" value="">
<div class="g-widget" id="gate-widget" aria-label="CAPTCHA check"${error ? ' hidden' : ''}></div>
</form>
<p class="g-status" id="gate-status" role="status" aria-live="polite"></p>
<div class="g-error" id="gate-error" role="alert"${error ? '' : ' hidden'}>
<p id="gate-error-text">${escapeHtml(error)}</p>
<button type="button" class="g-btn" id="gate-retry">Try again</button>
</div>
<noscript><p class="g-noscript"><strong>JavaScript is required.</strong>This check runs in your browser. Turn on JavaScript for ${escapeHtml(siteDomain)} and challenges.cloudflare.com, then reload the page.</p></noscript>
</main>
<script nonce="${n}">${CHALLENGE_JS}</script>
</body>
</html>`;
}

/* ---------------------------------------------------------------- request -- */

function isNavigation(request) {
  const m = request.method;
  if (m !== 'GET' && m !== 'HEAD') return false;
  const h = request.headers;
  if (str(h.get('upgrade'))) return false;
  const dest = str(h.get('sec-fetch-dest')).toLowerCase();
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  const accept = str(h.get('accept')).toLowerCase();
  return accept.includes('text/html') || accept.includes('application/xhtml+xml');
}

function wantsHtml(request) {
  const h = request.headers;
  const dest = str(h.get('sec-fetch-dest')).toLowerCase();
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  return str(h.get('accept')).toLowerCase().includes('text/html');
}

async function readBounded(request, limit) {
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.byteLength; }
  return dec.decode(all);
}

function readConfig(env) {
  const e = env && typeof env === 'object' ? env : {};
  return {
    siteKey: str(e.TURNSTILE_SITE_KEY),
    secret: str(e.TURNSTILE_SECRET_KEY) || str(e.TURNSTILE_SECRET),
    gateSecret: str(e.GATE_SECRET),
    mode: str(e.GATE_MODE).toLowerCase(),
  };
}

function configProblem(cfg, local) {
  if (!cfg.siteKey || !cfg.secret) return { code: 'not_configured', message: MSG_NOT_CONFIGURED };
  if (!local && (isTestSiteKey(cfg.siteKey) || isTestSecret(cfg.secret))) return { code: 'test_keys', message: MSG_TEST_KEYS };
  if (cfg.gateSecret && cfg.gateSecret.length < 32) return { code: 'weak_gate_secret', message: MSG_WEAK_SECRET };
  return null;
}

/**
 * The console posture item, from the deploy's variables alone (no request).
 * state: 'on' | 'off' | 'not_configured' | 'misconfigured'. Test keys count as
 * misconfigured here because the console describes production.
 */
export function gateStatus(env) {
  const cfg = readConfig(env);
  if (cfg.mode === 'off') {
    return {
      state: 'off', ok: false, label: 'CAPTCHA wall is OFF',
      detail: 'GATE_MODE="off" is set, so every request loads without a CAPTCHA. Remove the variable to turn the wall back on.',
    };
  }
  const problem = configProblem(cfg, false);
  if (problem && problem.code === 'not_configured') {
    return {
      state: 'not_configured', ok: false, label: 'CAPTCHA wall is not configured',
      detail: 'TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must both be set. Until they are, every request gets a 503.',
    };
  }
  if (problem) {
    return {
      state: 'misconfigured', ok: false, label: 'CAPTCHA wall is misconfigured',
      detail: problem.message.replace(/^Not available: /, '') + ' Every request gets a 503.',
    };
  }
  return {
    state: 'on', ok: true, label: 'CAPTCHA wall is on',
    detail: 'Every visitor solves a Turnstile CAPTCHA before anything loads. Passes are signed with '
      + (cfg.gateSecret ? 'GATE_SECRET.' : 'a key derived from the Turnstile secret.'),
  };
}

const VERIFY_MESSAGES = {
  network: "We couldn't reach the CAPTCHA service. Please try again in a moment.",
  expired: 'That check expired before it was sent. Please try again.',
  generic: "That check didn't go through. Please try again.",
};

/* ------------------------------------------------------------------ gate -- */

/**
 * Build the gate for one site. Create it once at module scope.
 *
 * options.siteName     shown on the challenge page (required)
 * options.siteDomain   shown above the name; defaults to the request's hostname
 * options.getSetting   (key, env) => value | null | Promise; asked for
 *                      'captcha_pass_hours' when a pass is issued
 * options.exempt       (request, url, env) => exemption name | null | Promise;
 *                      machine clients only (PORTAL-STANDARD §10)
 * options.onEvent      (type, detail, env) => void | Promise; counters only
 * options.onStats      (rows, env) => void | Promise; batched counts per UTC
 *                      hour, at most once per statsFlushSeconds per isolate
 * options.statsFlushSeconds  default 60
 * options.now          () => epoch ms (tests)
 * options.fetch        fetch used for siteverify (tests)
 */
export function createGate(options = {}) {
  const siteName = str(options.siteName) || 'this site';
  const fixedDomain = str(options.siteDomain);
  const getSetting = typeof options.getSetting === 'function' ? options.getSetting : null;
  const exempt = typeof options.exempt === 'function' ? options.exempt : null;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const onStats = typeof options.onStats === 'function' ? options.onStats : null;
  const flushMs = Math.max(1, Number(options.statsFlushSeconds) || 60) * 1000;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : (...a) => globalThis.fetch(...a);

  // Read the clock on the first request, not here: createGate() runs at
  // module scope, where workerd's clock reads 0 (1970-01-01).
  let startedAt = 0;
  const totals = Object.create(null);
  const pending = new Map();
  let lastFlush = 0;
  const lastQuiet = Object.create(null);
  // Requests let through on an exemption, so the site can answer them from
  // the machine-client handler only (see exemptionOf()).
  const exemptions = new WeakMap();

  function start() {
    if (startedAt) return;
    const t = now();
    if (t > 0) startedAt = lastFlush = t;
  }

  function background(p, ctx) {
    if (!p || typeof p.then !== 'function') return;
    const safe = Promise.resolve(p).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(safe); } catch { /* not in a request */ }
    }
  }

  function count(type) {
    totals[type] = (totals[type] || 0) + 1;
    if (!onStats) return;
    const k = hourBucket(now()) + '\t' + type;
    if (pending.has(k) || pending.size < MAX_PENDING_STATS) pending.set(k, (pending.get(k) || 0) + 1);
  }

  function drain() {
    const rows = [];
    for (const [k, n] of pending) {
      const [hour, event] = k.split('\t');
      rows.push({ hour, event, count: n });
    }
    pending.clear();
    return rows;
  }

  function flush(env, ctx, force) {
    if (!onStats || pending.size === 0) return null;
    if (!force && now() - lastFlush < flushMs) return null;
    lastFlush = now();
    const rows = drain();
    let p;
    try {
      p = Promise.resolve(onStats(rows, env));
    } catch (e) {
      p = Promise.reject(e);
    }
    const settled = p.catch(() => {
      // Put the counts back so the next flush retries them.
      for (const r of rows) {
        const k = r.hour + '\t' + r.event;
        if (pending.has(k) || pending.size < MAX_PENDING_STATS) pending.set(k, (pending.get(k) || 0) + r.count);
      }
    });
    background(settled, ctx);
    return settled;
  }

  function emit(type, detail, env, ctx) {
    count(type);
    if (!onEvent) return;
    if (type === 'misconfigured' || type === 'gate_off') {
      const t = now();
      if (lastQuiet[type] && t - lastQuiet[type] < QUIET_EVENT_MS) return;
      lastQuiet[type] = t;
    }
    try {
      background(onEvent(type, detail, env), ctx);
    } catch { /* a hook must never change the gate's answer */ }
  }

  function describe(request, url, ip) {
    const cf = request.cf && typeof request.cf === 'object' ? request.cf : null;
    return {
      ip,
      host: url.host.toLowerCase(),
      path: url.pathname.slice(0, 300),
      method: request.method,
      country: str(cf && cf.country) || str(request.headers.get('cf-ipcountry')) || null,
      ua: str(request.headers.get('user-agent')).slice(0, 256),
      hour: hourBucket(now()),
    };
  }

  async function passHours(env) {
    let v = null;
    if (getSetting) {
      try { v = await getSetting('captcha_pass_hours', env); } catch { v = null; }
    }
    const n = typeof v === 'string' ? Number(v.trim()) : typeof v === 'number' ? v : NaN;
    if (v === null || v === '' || !Number.isFinite(n)) return PASS_HOURS.default;
    return Math.min(PASS_HOURS.max, Math.max(PASS_HOURS.min, Math.round(n)));
  }

  function keyMaterial(cfg) {
    return cfg.gateSecret ? 'GATE_SECRET\u0000' + cfg.gateSecret : 'TURNSTILE_SECRET_KEY\u0000' + cfg.secret;
  }

  async function checkPass(request, cfg, host, ip) {
    const values = readCookies(request.headers.get('cookie'), PASS_COOKIE);
    if (values.length === 0) return { ok: false, reason: 'no_pass' };
    const key = await derivePassKey(keyMaterial(cfg));
    const expect = { host, ip, uah: await uaHash(request.headers.get('user-agent')) };
    const nowSec = Math.floor(now() / 1000);
    let first = null;
    for (const v of values) {
      const r = await verifyPass(v, key, expect, nowSec);
      if (r.ok) return r;
      if (!first) first = r;
    }
    return first;
  }

  function challenge(request, url, cfg, { status = 403, error = '', returnPath } = {}) {
    const nonce = randomToken(16);
    const html = renderChallengePage({
      siteName,
      siteDomain: fixedDomain || url.hostname,
      siteKey: cfg.siteKey,
      nonce,
      returnPath: returnPath || url.pathname + url.search,
      error,
    });
    return new Response(request.method === 'HEAD' ? null : html, {
      status,
      headers: baseHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': challengeCsp(nonce),
        'X-Frame-Options': 'DENY',
      }),
    });
  }

  function captchaRequired(request, url, local) {
    const origin = local ? url.origin : 'https://' + url.host;
    return jsonResponse(403, {
      ok: false,
      code: 'captcha_required',
      error: `Complete the CAPTCHA at ${origin}/ first.`,
    }, request.method);
  }

  async function verify(request, url, cfg, info, env, ctx, local) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Response(null, { status: 303, headers: baseHeaders({ Location: '/' }) });
    }
    if (request.method !== 'POST') return captchaRequired(request, url, local);

    const html = wantsHtml(request);
    let returnPath = '/';
    const fail = (reason, extra = {}, status = 403, message = VERIFY_MESSAGES.generic) => {
      emit('verify_failed', { ...info, reason, ...extra }, env, ctx);
      if (html) return challenge(request, url, cfg, { status, error: message, returnPath });
      return jsonResponse(status, { ok: false, code: 'captcha_failed', error: message }, request.method);
    };

    const origin = request.headers.get('origin');
    if (origin && origin !== 'null') {
      let oh = '';
      try { oh = new URL(origin).host.toLowerCase(); } catch { oh = ''; }
      if (oh !== info.host) return fail('cross_origin');
    }
    const ct = str(request.headers.get('content-type')).toLowerCase();
    if (!ct.startsWith('application/x-www-form-urlencoded')) return fail('bad_request');
    let body;
    try { body = await readBounded(request, MAX_BODY); } catch { body = null; }
    if (body === null) return fail('bad_request');
    const form = new URLSearchParams(body);
    returnPath = safeReturnPath(form.get('return') || '/');
    const token = str(form.get('token')) || str(form.get('cf-turnstile-response'));
    if (!token) return fail('missing_token');
    if (token.length > MAX_TOKEN_LEN || !/^[\x21-\x7e]+$/.test(token)) return fail('malformed_token');
    if (!local && isTestToken(token)) return fail('test_token');

    let data;
    try {
      const params = new URLSearchParams({ secret: cfg.secret, response: token });
      if (info.ip) params.set('remoteip', info.ip);
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) : undefined;
      const res = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body: params, signal });
      if (!res || !res.ok) return fail('siteverify_http', { status: res ? res.status : 0 }, 503, VERIFY_MESSAGES.network);
      data = await res.json();
    } catch {
      return fail('network_error', {}, 503, VERIFY_MESSAGES.network);
    }
    const codes = data && Array.isArray(data['error-codes']) ? data['error-codes'].map(String).slice(0, 8) : [];
    if (!data || data.success !== true) {
      const expired = codes.includes('timeout-or-duplicate');
      return fail('rejected', { codes }, 403, expired ? VERIFY_MESSAGES.expired : VERIFY_MESSAGES.generic);
    }
    // Cloudflare's test secret answers for a fixed hostname; only on a
    // loopback request with a test secret are hostname and action relaxed.
    if (!(local && isTestSecret(cfg.secret))) {
      if (str(data.hostname).toLowerCase() !== url.hostname.toLowerCase()) {
        return fail('hostname_mismatch', { hostname: str(data.hostname).slice(0, 255) });
      }
      if (data.action !== GATE_ACTION) return fail('action_mismatch', { action: str(data.action).slice(0, 64) });
    }

    const hours = await passHours(env);
    const iat = Math.floor(now() / 1000);
    const exp = iat + hours * 3600;
    const key = await derivePassKey(keyMaterial(cfg));
    const value = await signPass(key, {
      host: info.host, ip: info.ip, uah: await uaHash(request.headers.get('user-agent')), iat, exp,
    });
    emit('verify_ok', { ...info, hours, exp }, env, ctx);
    const headers = baseHeaders({ Location: returnPath });
    headers.append('Set-Cookie', `${PASS_COOKIE}=${value}; Path=/; Max-Age=${hours * 3600}; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 303, headers });
  }

  async function handle(request, env, ctx) {
    start();
    try {
      const url = new URL(request.url);
      const cfg = readConfig(env);
      const ip = canonicalIp(request.headers.get('cf-connecting-ip'));
      const info = describe(request, url, ip);
      if (cfg.mode === 'off') {
        emit('gate_off', info, env, ctx);
        return null;
      }
      const local = isLocalDev(url, ip);
      const problem = configProblem(cfg, local);
      if (problem) {
        emit('misconfigured', { ...info, reason: problem.code }, env, ctx);
        return textResponse(503, problem.message, request.method);
      }
      if (url.pathname === VERIFY_PATH) return await verify(request, url, cfg, info, env, ctx, local);

      if (exempt) {
        let name = null;
        try { name = await exempt(request, url, env); } catch { name = null; }
        if (name) {
          const label = typeof name === 'string' ? name.slice(0, 64) : 'exempt';
          exemptions.set(request, label);
          emit('exempted', { ...info, exemption: label }, env, ctx);
          return null;
        }
      }

      const pass = await checkPass(request, cfg, info.host, ip);
      if (pass.ok) {
        count('passed');
        return null;
      }
      if (isNavigation(request)) {
        emit('challenge_served', { ...info, reason: pass.reason }, env, ctx);
        return challenge(request, url, cfg);
      }
      emit('blocked', { ...info, reason: pass.reason }, env, ctx);
      return captchaRequired(request, url, local);
    } catch {
      // Fail closed: a bug or a missing runtime feature is never a pass.
      return textResponse(503, MSG_GATE_FAILED, request && request.method);
    } finally {
      flush(env, ctx, false);
    }
  }

  /**
   * Make a response served on a pass safe from shared caches: Vary: Cookie,
   * and Cache-Control "private" (public / s-maxage dropped). Headers are
   * changed in place when they are mutable, else the response is re-wrapped.
   * A 101 WebSocket upgrade is returned untouched.
   */
  function decorate(response) {
    if (!response || typeof response !== 'object' || response.status === 101 || response.webSocket) return response;
    const fix = (h) => {
      const vary = str(h.get('vary'));
      if (!vary) h.set('Vary', 'Cookie');
      else if (vary !== '*' && !/(^|,)\s*cookie\s*(,|$)/i.test(vary)) h.set('Vary', vary + ', Cookie');
      h.set('Cache-Control', privateCacheControl(h.get('cache-control')));
      // CDN-only cache headers outrank Cache-Control at the CDN: drop them.
      const drop = [];
      for (const [name] of h) if (isSharedCacheHeader(name)) drop.push(name);
      for (const name of drop) h.delete(name);
    };
    try {
      fix(response.headers);
      return response;
    } catch {
      const copy = new Response(response.body, response);
      fix(copy.headers);
      return copy;
    }
  }

  /**
   * The exemption name when handle() let this request through only because
   * the exempt hook matched it (no pass), else null. A site must answer such
   * a request from the machine-client handler alone: anything that handler
   * doesn't serve gets a bare 404, never scanner/decoy detection, alerts,
   * the site's 404 page or an assets fallback.
   */
  function exemptionOf(request) {
    return (request && typeof request === 'object' && exemptions.get(request)) || null;
  }

  async function run(request, env, ctx, next) {
    const blocked = await handle(request, env, ctx);
    if (blocked) return blocked;
    return decorate(await next());
  }

  /** `since` is when this isolate/process handled its first request. */
  function stats() {
    start();
    return { since: new Date(startedAt || now()).toISOString(), totals: { ...totals }, pending: pending.size };
  }

  async function flushStats(env, ctx) {
    const p = flush(env, ctx, true);
    if (p) await p;
  }

  return { handle, decorate, exemptionOf, run, stats, flushStats, siteName };
}

/**
 * Headers that tell a shared cache (and only a shared cache) how long to keep
 * a response, overriding Cache-Control there: CDN-Cache-Control and every
 * targeted "<vendor>-CDN-Cache-Control" (RFC 9213, e.g. Cloudflare's),
 * Surrogate-Control, and nginx's X-Accel-Expires. A response served on a
 * pass must not carry any of them.
 */
export function isSharedCacheHeader(name) {
  const n = str(name).toLowerCase();
  return n === 'cdn-cache-control' || n.endsWith('-cdn-cache-control') || n === 'surrogate-control' || n === 'x-accel-expires';
}

/** "public, max-age=600, s-maxage=3600" -> "private, max-age=600". no-store is kept as is. */
export function privateCacheControl(value) {
  const cc = str(value);
  if (!cc) return 'private';
  const parts = cc.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => /^no-store$/i.test(p))) {
    return parts.some((p) => /^private$/i.test(p)) ? parts.join(', ') : parts.concat('private').join(', ');
  }
  const kept = parts.filter((p) => !/^(public|private|s-maxage\s*=.*|proxy-revalidate)$/i.test(p));
  return ['private'].concat(kept).join(', ');
}
