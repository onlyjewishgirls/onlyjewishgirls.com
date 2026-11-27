/* ==========================================================================
   Gate kit, Node adapter: run gate.mjs in front of a Node http server or an
   Express app (chaimyuirmafia.com server.js, which mirrors its Worker).

     import { createGate } from './gate.mjs';
     import { createNodeGate } from './gate-node.mjs';
     const gate = createGate({ siteName: 'Example' });
     const nodeGate = createNodeGate(gate, { env: process.env, trustCloudflare: ['127.0.0.1', '::1'] });
     app.use(nodeGate);                         // Express / connect
     // or: http.createServer(async (req, res) => { if (await nodeGate(req, res)) return; ... })

   The client address is the socket's. CF-Connecting-IP is believed only when
   the operator says who sets it (trustCloudflare), and X-Forwarded-For is
   never read. Whatever address is chosen is written into the web Request's
   CF-Connecting-IP, which is the only header gate.mjs reads.

   Behind a reverse proxy every socket peer is the proxy, so the adapter
   refuses (503) to bind passes to a loopback, private or missing address:
   one solve would otherwise unlock every visitor. The proxy must overwrite
   CF-Connecting-IP with the visitor's address and be named in
   trustCloudflare (INTEGRATION.md 4(c)).
   ========================================================================== */

import {
  VERIFY_PATH, MSG_TEST_KEYS, canonicalIp, privateCacheControl, isPrivateAddress, isLoopbackHost,
  isSharedCacheHeader, isTestSiteKey, isTestSecret, gateStatus,
} from './gate.mjs';

// Node 18 has Web Crypto but not on globalThis without a flag; 19+ does.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

const MAX_VERIFY_BODY = 16 * 1024;

export const MSG_PRIVATE_CLIENT =
  "Not available: CAPTCHA is misconfigured (the server sees a proxy's or a private address, not the visitor's). " +
  "Make the reverse proxy OVERWRITE CF-Connecting-IP with the visitor's address (with Cloudflare in front, via realip / trusted_proxies), " +
  "then set GATE_TRUST_CLOUDFLARE to the proxy's address. See gate-kit INTEGRATION.md 4(c).";

// Any of these means the request came through a proxy, so it is not a
// browser on the developer's own machine, whatever its Host says.
const PROXY_HEADERS = [
  'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-forwarded-server', 'x-real-ip', 'x-client-ip', 'x-cluster-client-ip', 'true-client-ip',
  'cf-connecting-ip', 'cf-ray',
];

function isLoopbackPeer(ip) {
  return ip === '::1' || /^127\./.test(ip);
}

/** True when the request arrived over a Unix-domain socket (no peer address). */
function isUnixSocket(req) {
  const s = req && req.socket;
  if (!s || typeof s.remoteAddress === 'string') return false;
  try {
    return Boolean(s.server && typeof s.server.address === 'function' && typeof s.server.address() === 'string');
  } catch {
    return false;
  }
}

/**
 * The client address for a Node request.
 *   trustCloudflare: false (default)  -> the socket address, always
 *   trustCloudflare: true             -> CF-Connecting-IP when present (only
 *                                        say this when every request really
 *                                        arrives through Cloudflare, e.g. a
 *                                        firewall that admits only Cloudflare's
 *                                        ranges)
 *   trustCloudflare: ['127.0.0.1', '::1', 'unix'] -> CF-Connecting-IP only
 *                                        when the socket peer is one of these
 *                                        ('unix': a Unix-domain socket), else
 *                                        the socket address. The peer (Caddy,
 *                                        nginx, cloudflared) must OVERWRITE
 *                                        the header, never pass a client's on.
 */
export function clientIpOf(req, { trustCloudflare = false } = {}) {
  const peer = canonicalIp(req.socket && req.socket.remoteAddress);
  let trusted = false;
  if (trustCloudflare === true) {
    trusted = true;
  } else if (Array.isArray(trustCloudflare)) {
    const list = trustCloudflare.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    trusted = (peer !== '' && list.map(canonicalIp).includes(peer)) || (list.includes('unix') && isUnixSocket(req));
  }
  if (trusted) {
    const raw = req.headers['cf-connecting-ip'];
    const v = canonicalIp(Array.isArray(raw) ? raw[0] : raw);
    if (v) return v;
  }
  return peer;
}

function headerList(req) {
  const out = [];
  const raw = req.headers;
  for (const name of Object.keys(raw)) {
    if (name.startsWith(':')) continue; // HTTP/2 pseudo-headers
    const v = raw[name];
    if (v === undefined) continue;
    out.push([name, Array.isArray(v) ? v.join(name === 'cookie' ? '; ' : ', ') : String(v)]);
  }
  return out;
}

async function readCapped(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (total <= limit) chunks.push(b.subarray(0, limit + 1 - total));
    total += b.length;
  }
  return Buffer.concat(chunks).subarray(0, limit + 1);
}

/**
 * The request target as the app will route it ("/path?query"), checked so
 * the gate and the app can't disagree about which path this is. WHATWG URL
 * (what the gate and its exempt hook see) resolves "..", "%2e%2e" and "\",
 * while Express and most Node routers use the raw string. So a raw path with
 * a dot-segment, a backslash or anything outside printable ASCII is refused
 * (a browser never sends one). Absolute-form targets keep only their path.
 */
function requestTarget(raw) {
  let target = String(raw || '/');
  if (!target.startsWith('/')) {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([\s\S]*)$/.exec(target);
    if (!m) return '/'; // asterisk-form ("OPTIONS *") or authority-form (CONNECT)
    target = m[1].startsWith('/') ? m[1] : '/' + m[1];
  }
  const cut = target.search(/[?#]/);
  const path = cut < 0 ? target : target.slice(0, cut);
  if (/[^\x21-\x7e]/.test(path) || path.includes('\\')) throw new TypeError('gate-node: unsafe request path');
  for (const seg of path.split('/')) {
    const s = seg.replace(/%2e/gi, '.');
    if (s === '.' || s === '..') throw new TypeError('gate-node: dot-segment in request path');
  }
  return target;
}

/**
 * IncomingMessage -> web Request.
 *   options.trustCloudflare  see clientIpOf()
 *   options.protocol         'https' | 'http'; default: https when the socket
 *                            is TLS or trustCloudflare is set, else http
 *   options.body             a Buffer/Uint8Array/string to use as the body
 *                            (default: none). The gate only reads a body on
 *                            POST /__gate/verify; createNodeGate passes one
 *                            only there, so the app's own body parsers still
 *                            get an untouched stream everywhere else.
 * Throws a TypeError for a bad Host header or an unsafe request path
 * (createNodeGate answers those with a 400).
 */
export function toWebRequest(req, options = {}) {
  const ip = clientIpOf(req, options);
  const tls = Boolean(req.socket && req.socket.encrypted);
  const protocol = options.protocol || (tls || options.trustCloudflare ? 'https' : 'http');
  const hostHeader = String(req.headers.host || req.headers[':authority'] || 'unknown.invalid');
  if (!/^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(hostHeader)) {
    throw new TypeError('gate-node: bad Host header');
  }
  // Build the URL by concatenation so a request target such as "//evil.com/x"
  // stays a path on this host.
  const url = new URL(`${protocol}://${hostHeader}${requestTarget(req.url)}`);
  const headers = new Headers();
  for (const [k, v] of headerList(req)) {
    try { headers.append(k, v); } catch { /* drop a header fetch refuses */ }
  }
  headers.delete('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  const method = String(req.method || 'GET').toUpperCase();
  const init = { method, headers };
  if (options.body != null && method !== 'GET' && method !== 'HEAD') init.body = options.body;
  return new Request(url, init);
}

function gone(res) {
  return Boolean(res.destroyed || res.writableEnded || (res.socket && res.socket.destroyed));
}

/** Resolves true on 'drain', false when the response closes or errors first. */
function drained(res) {
  return new Promise((resolve) => {
    const finish = (ok) => {
      res.off('drain', onDrain);
      res.off('close', onGone);
      res.off('error', onGone);
      resolve(ok);
    };
    const onDrain = () => finish(true);
    const onGone = () => finish(false);
    res.on('drain', onDrain);
    res.on('close', onGone);
    res.on('error', onGone);
    if (gone(res)) finish(false);
  });
}

/**
 * Write a web Response to a ServerResponse. Resolves when the body is sent,
 * or as soon as the client has gone away (the rest of the body is dropped).
 */
export async function writeWebResponse(res, response, method = 'GET') {
  const body = response.body;
  const discard = async () => {
    if (body) { try { await body.cancel(); } catch { /* ignore */ } }
  };
  if (gone(res)) { await discard(); return; }
  res.statusCode = response.status;
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  for (const [k, v] of response.headers) {
    if (k === 'set-cookie') continue;
    res.setHeader(k, v);
  }
  if (cookies.length) res.setHeader('set-cookie', cookies);
  if (method === 'HEAD' || !body || response.status === 204 || response.status === 304) {
    await discard();
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      if (gone(res)) { try { await reader.cancel(); } catch { /* ignore */ } return; }
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value) && !(await drained(res))) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return;
      }
    }
  } finally {
    if (!gone(res)) res.end();
  }
}

/**
 * The Node twin of gate.decorate(): on a passed request, whatever the app
 * writes later goes out with Vary: Cookie, a private Cache-Control and no
 * CDN-only cache headers (CDN-Cache-Control, *-CDN-Cache-Control,
 * Surrogate-Control, X-Accel-Expires), whichever way it sets its headers.
 */
export function privatizeNodeResponse(res) {
  const original = res.writeHead;
  res.writeHead = function patchedWriteHead(statusCode, ...rest) {
    const last = rest[rest.length - 1];
    if (Array.isArray(last) && last.length % 2 === 0) {
      // writeHead(status, [k1, v1, k2, v2, ...]): Node replaces earlier
      // headers of those names and keeps repeated names. Do the same here,
      // so the private headers below are applied after the app's.
      rest.pop();
      const byName = new Map();
      for (let i = 0; i < last.length; i += 2) {
        if (!last[i]) continue;
        const name = String(last[i]);
        const key = name.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name, values: [] });
        const v = last[i + 1];
        byName.get(key).values.push(...(Array.isArray(v) ? v : [v]));
      }
      for (const { name, values } of byName.values()) this.setHeader(name, values.length === 1 ? values[0] : values);
    } else if (last && typeof last === 'object' && !Array.isArray(last)) {
      rest.pop();
      for (const [k, v] of Object.entries(last)) if (v !== undefined) this.setHeader(k, v);
    }
    if (statusCode !== 101 && !this.headersSent) {
      const vary = String(this.getHeader('vary') || '').trim();
      if (!vary) this.setHeader('Vary', 'Cookie');
      else if (vary !== '*' && !/(^|,)\s*cookie\s*(,|$)/i.test(vary)) this.setHeader('Vary', vary + ', Cookie');
      this.setHeader('Cache-Control', privateCacheControl(this.getHeader('cache-control')));
      for (const name of this.getHeaderNames()) if (isSharedCacheHeader(name)) this.removeHeader(name);
    }
    return original.call(this, statusCode, ...rest);
  };
  return res;
}

function plain(res, status, text) {
  if (gone(res)) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(text);
}

/**
 * A browser on this machine: local development explicitly allowed, a
 * loopback socket peer, a loopback Host, and no sign of a proxy.
 */
function isLocalRequest(req, options) {
  if (options.localDev !== true || isProduction()) return false;
  if (!isLoopbackPeer(canonicalIp(req.socket && req.socket.remoteAddress))) return false;
  if (!isLocalhostName(String(req.headers.host || ''))) return false;
  return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

/**
 * Only the `localhost` / `*.localhost` spelling counts on Node. A stock nginx
 * `proxy_pass http://127.0.0.1:3000;` rewrites Host to `127.0.0.1:3000` and
 * adds no proxy headers, so accepting IP-literal hosts would make every
 * visitor behind it "local development".
 */
function isLocalhostName(host) {
  if (!isLoopbackHost(host)) return false;
  const h = host.toLowerCase().replace(/:\d{1,5}$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

function isProduction() {
  try {
    return typeof process !== 'undefined' && String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  } catch {
    return false;
  }
}

function usesTestKeys(env) {
  const e = env && typeof env === 'object' ? env : {};
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  return isTestSiteKey(s(e.TURNSTILE_SITE_KEY)) || isTestSecret(s(e.TURNSTILE_SECRET_KEY) || s(e.TURNSTILE_SECRET));
}

/**
 * Connect/Express-style middleware: (req, res, next?) => Promise<boolean>.
 * Resolves true when the gate answered (challenge, 403, 400, 503, verify),
 * false when the request passed and next() was called. It always settles,
 * also when the client disconnects first.
 *   options.env              where the keys live (default process.env)
 *   options.trustCloudflare  see clientIpOf()
 *   options.protocol         see toWebRequest()
 *   options.localDev         true ONLY on a developer's machine: Cloudflare's
 *                            test keys and a loopback client address are
 *                            accepted for a request from a loopback socket
 *                            with Host localhost / *.localhost and no proxy
 *                            headers. Ignored when NODE_ENV=production.
 *                            On a pass via the exempt hook, req.gateExemption
 *                            is set to the exemption's name.
 *   options.ctx              optional { waitUntil } for hook promises
 */
export function createNodeGate(gate, options = {}) {
  const env = options.env || process.env;
  if (options.localDev === true && typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(isProduction()
      ? 'gate-kit: localDev is set but NODE_ENV=production, so it is ignored. Never set GATE_LOCAL_DEV in production.'
      : 'gate-kit: localDev is ON. Test keys and loopback addresses are accepted from http://localhost. Never set this in production.',
    { code: 'GATE_LOCAL_DEV' });
  }
  return async function nodeGate(req, res, next) {
    let request;
    try {
      const pathOnly = String(req.url || '/').split('?')[0];
      let body;
      if (req.method === 'POST' && pathOnly === VERIFY_PATH) body = await readCapped(req, MAX_VERIFY_BODY);
      request = toWebRequest(req, { ...options, body });
    } catch {
      plain(res, 400, 'Bad Request');
      return true;
    }
    // Before the gate: an address that can't stand for one visitor, and the
    // always-pass test keys, are only acceptable for local development. The
    // gate's own answer covers GATE_MODE="off" and missing keys.
    const state = gateStatus(env).state;
    if ((state === 'on' || state === 'misconfigured') && !isLocalRequest(req, options)) {
      if (usesTestKeys(env)) { plain(res, 503, MSG_TEST_KEYS); return true; }
      if (state === 'on' && isPrivateAddress(request.headers.get('cf-connecting-ip'))) {
        plain(res, 503, MSG_PRIVATE_CLIENT);
        return true;
      }
    }
    let answer;
    try {
      answer = await gate.handle(request, env, options.ctx);
    } catch {
      // Fail closed: an error in the gate is never a pass.
      plain(res, 503, 'Not available: the CAPTCHA gate failed.');
      return true;
    }
    if (answer) {
      try {
        await writeWebResponse(res, answer, req.method);
      } catch {
        if (!gone(res)) res.destroy();
      }
      return true;
    }
    const exemption = typeof gate.exemptionOf === 'function' ? gate.exemptionOf(request) : null;
    if (exemption) req.gateExemption = exemption;
    privatizeNodeResponse(res);
    if (typeof next === 'function') next();
    return false;
  };
}
