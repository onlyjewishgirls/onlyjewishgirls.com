// Gate kit tests: node --test test/gate.test.mjs
// No network: every siteverify call goes through a mock, and global fetch is
// replaced with one that throws, so a leak fails loudly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import vm from 'node:vm';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createGate, VERIFY_PATH, PASS_COOKIE, SITEVERIFY_URL, MSG_NOT_CONFIGURED, TURNSTILE_API,
  canonicalIp, safeReturnPath, timingSafeEqual, derivePassKey, signPass, verifyPass, uaHash,
  readCookies, privateCacheControl, isTestSiteKey, isTestSecret, isTestToken, renderChallengePage, gateStatus,
  isPrivateAddress, isLoopbackHost, isSharedCacheHeader, MSG_TEST_KEYS,
} from '../gate.mjs';
import {
  createNodeGate, toWebRequest, clientIpOf, writeWebResponse, privatizeNodeResponse, MSG_PRIVATE_CLIENT,
} from '../gate-node.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network is disabled in tests'); };

const HOST = 'portal.example.com';
const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (Test) Gate/1.0';
const ENV = Object.freeze({
  TURNSTILE_SITE_KEY: '0x4AAAAAAAsiteKEYforTESTS',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecretKEYforTESTSonly00',
});
const T0 = Date.parse('2026-11-12T12:00:00Z');

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function siteverify(answer = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, params: Object.fromEntries(new URLSearchParams(String(init.body))) });
    if (typeof answer === 'function') return answer(url, init);
    return new Response(JSON.stringify({ success: true, hostname: HOST, action: 'gate', 'error-codes': [], ...answer }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

function req(pathname, { method = 'GET', host = HOST, ip = IP, ua = UA, accept, cookie, headers = {}, body, scheme = 'https' } = {}) {
  const h = new Headers(headers);
  if (ip !== null) h.set('cf-connecting-ip', ip);
  if (ua !== null) h.set('user-agent', ua);
  if (accept) h.set('accept', accept);
  if (cookie) h.set('cookie', cookie);
  return new Request(`${scheme}://${host}${pathname}`, { method, headers: h, ...(body !== undefined ? { body } : {}) });
}

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function verifyReq({ token = 'tok.en_-123', ret = '/', host = HOST, ip = IP, ua = UA, origin, accept = HTML, extra = '' } = {}) {
  const body = `token=${encodeURIComponent(token)}&return=${encodeURIComponent(ret)}${extra}`;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (origin !== null) headers.origin = origin || `https://${host}`;
  return req(VERIFY_PATH, { method: 'POST', host, ip, ua, accept, headers, body });
}

function cookieFrom(res) {
  const set = res.headers.get('set-cookie');
  assert.ok(set, 'expected a Set-Cookie');
  return set.split(';')[0];
}

async function passFor(gate, opts = {}) {
  const res = await gate.handle(verifyReq(opts), opts.env || ENV);
  assert.equal(res.status, 303, 'verify should succeed');
  return cookieFrom(res);
}

function assertGateHeaders(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store, private');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
}

function makeGate(extra = {}) {
  const sv = extra.fetch || siteverify();
  const now = extra.now || clock();
  const gate = createGate({ siteName: 'Example Portal', fetch: sv, now, ...extra });
  return { gate, sv, now };
}

/* ------------------------------------------------------------- the pass -- */

describe('pass sign / verify', () => {
  const expect = { host: HOST, ip: IP, uah: 'abcdefghijklmnopqrstuv' };
  const nowSec = Math.floor(T0 / 1000);
  const claims = { ...expect, iat: nowSec, exp: nowSec + 3600 };

  test('round trip', async () => {
    const key = await derivePassKey('secret-material');
    const v = await signPass(key, claims);
    assert.match(v, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const r = await verifyPass(v, key, expect, nowSec);
    assert.equal(r.ok, true);
    assert.equal(r.claims.ip, IP);
  });

  test('tampered payload or signature is refused', async () => {
    const key = await derivePassKey('secret-material');
    const v = await signPass(key, claims);
    const [, body, sig] = v.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.ip = '198.51.100.1';
    const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
    assert.deepEqual(await verifyPass(`v1.${forgedBody}.${sig}`, key, { ...expect, ip: '198.51.100.1' }, nowSec), { ok: false, reason: 'bad_signature' });
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    assert.equal((await verifyPass(`v1.${body}.${flipped}`, key, expect, nowSec)).reason, 'bad_signature');
    const other = await derivePassKey('another-secret');
    assert.equal((await verifyPass(v, other, expect, nowSec)).reason, 'bad_signature');
  });

  test('expiry, wrong IP, wrong host, changed user agent', async () => {
    const key = await derivePassKey('secret-material');
    const v = await signPass(key, claims);
    assert.equal((await verifyPass(v, key, expect, nowSec + 3600)).reason, 'expired');
    assert.equal((await verifyPass(v, key, expect, nowSec + 3599)).ok, true);
    assert.equal((await verifyPass(v, key, { ...expect, ip: '203.0.113.8' }, nowSec)).reason, 'ip_changed');
    assert.equal((await verifyPass(v, key, { ...expect, host: 'evil.example.com' }, nowSec)).reason, 'host_mismatch');
    assert.equal((await verifyPass(v, key, { ...expect, uah: 'zzzzzzzzzzzzzzzzzzzzzz' }, nowSec)).reason, 'ua_changed');
  });

  test('clock skew: a little in the future is fine, a lot is not', async () => {
    const key = await derivePassKey('secret-material');
    const soon = await signPass(key, { ...claims, iat: nowSec + 60, exp: nowSec + 3660 });
    assert.equal((await verifyPass(soon, key, expect, nowSec)).ok, true);
    const later = await signPass(key, { ...claims, iat: nowSec + 600, exp: nowSec + 4200 });
    assert.equal((await verifyPass(later, key, expect, nowSec)).reason, 'not_yet_valid');
  });

  test('a validly signed pass longer than 168 hours is refused', async () => {
    const key = await derivePassKey('secret-material');
    const v = await signPass(key, { ...claims, exp: nowSec + 169 * 3600 });
    assert.equal((await verifyPass(v, key, expect, nowSec)).reason, 'malformed');
  });

  test('oversized, garbage and wrongly shaped cookies are refused before any crypto', async () => {
    const key = await derivePassKey('secret-material');
    for (const v of ['', 'x', 'v1..', 'v2.abc.def', 'v1.' + 'A'.repeat(2000) + '.' + 'B'.repeat(43), '\u0000\u0001',
      'v1.eyJ2IjoxfQ.' + 'A'.repeat(42), 'v1.eyJ2IjoxfQ!!.' + 'A'.repeat(43), 'x'.repeat(5000), null, 42]) {
      const r = await verifyPass(v, key, expect, nowSec);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'malformed', String(v).slice(0, 20));
    }
  });

  test('a correctly signed but non-JSON payload is refused', async () => {
    const key = await derivePassKey('secret-material');
    const body = Buffer.from('not json at all, really').toString('base64url');
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('v1.' + body))).toString('base64url');
    assert.equal((await verifyPass(`v1.${body}.${sig}`, key, expect, nowSec)).reason, 'malformed');
  });

  test('constant-time compare is what checks the MAC', async () => {
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
    assert.equal(timingSafeEqual(new Uint8Array(0), null), false);
    const src = verifyPass.toString();
    assert.match(src, /timingSafeEqual\(want, given\)/);
    assert.doesNotMatch(src, /m\[2\]\s*===|===\s*m\[2\]/, 'the signature string must never be compared with ===');
    // The loop has no early exit.
    assert.doesNotMatch(timingSafeEqual.toString(), /return false;\s*}\s*return/);
    assert.match(timingSafeEqual.toString(), /diff \|= a\[i\] \^ b\[i\]/);
  });

  test('readCookies copes with odd headers', () => {
    assert.deepEqual(readCookies(`a=1; ${PASS_COOKIE}=x; b=2; ${PASS_COOKIE}="y"`, PASS_COOKIE), ['x', 'y']);
    assert.deepEqual(readCookies(';;;===;', PASS_COOKIE), []);
    assert.deepEqual(readCookies(null, PASS_COOKIE), []);
    assert.equal(readCookies(Array(20).fill(`${PASS_COOKIE}=z`).join('; '), PASS_COOKIE).length, 4);
  });
});

/* ------------------------------------------------------------ addresses -- */

describe('addresses', () => {
  test('IPv6 spellings collapse to one, IPv4-mapped unwraps', () => {
    assert.equal(canonicalIp('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.equal(canonicalIp('2001:db8::0:1'), '2001:db8::1');
    assert.equal(canonicalIp('[2001:db8::1]'), '2001:db8::1');
    assert.equal(canonicalIp('fe80::1%eth0'), 'fe80::1');
    assert.equal(canonicalIp('::ffff:198.51.100.4'), '198.51.100.4');
    assert.equal(canonicalIp('::FFFF:c633:6404'), '198.51.100.4');
    assert.equal(canonicalIp('1:0:0:2:0:0:0:3'), '1:0:0:2::3');
    assert.equal(canonicalIp('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2:3:4:5:6');
    assert.equal(canonicalIp('::1'), '::1');
    assert.equal(canonicalIp(' 203.0.113.7 '), '203.0.113.7');
    assert.equal(canonicalIp(''), '');
    assert.equal(canonicalIp(null), '');
    assert.equal(canonicalIp('not-an-ip'), 'not-an-ip');
  });

  test('a pass issued over IPv6 holds for any spelling of that address, and only that address', async () => {
    const { gate } = makeGate();
    const cookie = await passFor(gate, { ip: '2001:DB8:0:0::1' });
    assert.equal(await gate.handle(req('/', { ip: '2001:db8::1', cookie, accept: HTML }), ENV), null);
    assert.equal(await gate.handle(req('/', { ip: '2001:0db8:0000::0001', cookie, accept: HTML }), ENV), null);
    const other = await gate.handle(req('/', { ip: '2001:db8::2', cookie, accept: HTML }), ENV);
    assert.equal(other.status, 403);
  });
});

describe('which addresses can stand for one visitor', () => {
  test('isPrivateAddress: loopback, private, CGNAT, link-local, ULA, empty and garbage are private', () => {
    for (const ip of [
      '', null, undefined, 'unix', 'not-an-ip', '0.0.0.0', '127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '100.64.0.1', '100.127.255.255', '169.254.10.10', '224.0.0.1', '255.255.255.255',
      '::', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fc00::1', 'fd12:3456::1', 'fe80::1%eth0', 'ff02::1',
    ]) assert.equal(isPrivateAddress(ip), true, String(ip));
    for (const ip of [
      '203.0.113.7', '198.51.100.1', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1',
      '192.169.0.1', '2001:db8::77', '2606:4700::1111', '::ffff:8.8.8.8',
    ]) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test('isLoopbackHost: localhost names with or without a port', () => {
    for (const h of ['localhost', 'LOCALHOST:8787', 'app.localhost', '127.0.0.1', '127.0.0.1:3000', '[::1]', '[::1]:8788']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ['', 'example.com', 'localhost.example.com', '127.0.0.2', '10.0.0.1:80', '[::2]', 'localhost.']) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });
});

/* ------------------------------------------------------------ test keys -- */

describe("Cloudflare's test keys", () => {
  test('are recognised, and real-looking keys are not', () => {
    assert.ok(isTestSiteKey('1x00000000000000000000AA'));
    assert.ok(isTestSiteKey('2x00000000000000000000AB'));
    assert.ok(isTestSiteKey('3x00000000000000000000FF'));
    assert.ok(isTestSecret('1x0000000000000000000000000000000AA'));
    assert.ok(isTestSecret('2x0000000000000000000000000000000AA'));
    assert.ok(isTestToken('XXXX.DUMMY.TOKEN.XXXX'));
    assert.ok(isTestToken('1x00000000000000000000AA'));
    assert.ok(!isTestSiteKey(ENV.TURNSTILE_SITE_KEY));
    assert.ok(!isTestSecret(ENV.TURNSTILE_SECRET_KEY));
    assert.ok(!isTestToken('0.abcDEF-real_token'));
  });
});

/* ---------------------------------------------------- the wall, no pass -- */

const CLASSES = [
  { name: 'HTML page', path: '/scripts', accept: HTML, html: true },
  { name: 'home page', path: '/', accept: HTML, html: true },
  { name: 'navigation by Sec-Fetch-Dest', path: '/x', headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }, html: true },
  { name: 'stylesheet', path: '/css/site.css', accept: 'text/css,*/*;q=0.1', headers: { 'sec-fetch-dest': 'style' } },
  { name: 'script', path: '/js/app.js', accept: '*/*', headers: { 'sec-fetch-dest': 'script' } },
  { name: 'image', path: '/img/logo.png', accept: 'image/avif,image/webp,*/*', headers: { 'sec-fetch-dest': 'image' } },
  { name: 'robots.txt', path: '/robots.txt', accept: '*/*' },
  { name: 'favicon', path: '/favicon.ico', accept: 'image/*', headers: { 'sec-fetch-dest': 'image' } },
  { name: 'sitemap', path: '/sitemap.xml' },
  { name: 'API GET', path: '/api/console/bootstrap', accept: 'application/json', headers: { 'sec-fetch-dest': 'empty' } },
  { name: 'API POST', path: '/api/login', method: 'POST', accept: 'application/json', headers: { 'content-type': 'application/json' }, body: '{"u":"a","p":"b"}' },
  { name: 'a 404 path', path: '/no/such/page', accept: HTML, html: true },
  { name: 'console', path: '/admin', accept: HTML, html: true },
  { name: 'HEAD of a page', path: '/', method: 'HEAD', accept: HTML, html: true, head: true },
  { name: 'HEAD of an asset', path: '/a.css', method: 'HEAD', head: true },
  { name: 'CORS preflight', path: '/api/data', method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST' } },
  { name: 'DELETE', path: '/api/thing/1', method: 'DELETE' },
  { name: 'PUT', path: '/api/thing/1', method: 'PUT', body: 'x' },
  { name: 'WebSocket upgrade', path: '/ws', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
  { name: 'fetch() of an HTML fragment', path: '/partials/x.html', accept: 'text/html', headers: { 'sec-fetch-dest': 'empty' } },
  { name: 'curl', path: '/', accept: '*/*', ua: 'curl/8.4.0' },
  { name: 'no client address at all', path: '/', accept: HTML, ip: null, html: true },
];

describe('every request class is blocked without a pass', () => {
  for (const c of CLASSES) {
    test(c.name, async () => {
      const { gate } = makeGate();
      let reached = false;
      const res = await gate.run(req(c.path, c), ENV, undefined, () => { reached = true; return new Response('SITE CONTENT'); });
      assert.equal(reached, false, 'the site must not run');
      assert.equal(res.status, 403);
      assertGateHeaders(res);
      for (const [k] of res.headers) assert.ok(!k.startsWith('access-control-'), `no CORS header (${k})`);
      const text = await res.text();
      assert.ok(!text.includes('SITE CONTENT'));
      if (c.head) assert.equal(text, '');
      if (c.html) {
        assert.match(res.headers.get('content-type'), /^text\/html/);
        assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
        if (!c.head) assert.match(text, /Checking that you're human before loading Example Portal\./);
      } else {
        assert.match(res.headers.get('content-type'), /^application\/json/);
        if (!c.head) {
          assert.deepEqual(JSON.parse(text), {
            ok: false, code: 'captcha_required', error: `Complete the CAPTCHA at https://${HOST}/ first.`,
          });
        }
      }
    });
  }
});

describe('every request class is allowed with a pass', () => {
  for (const c of CLASSES) {
    if (c.ip === null) continue; // a pass is bound to an address
    test(c.name, async () => {
      const { gate } = makeGate();
      const cookie = await passFor(gate, { ua: c.ua || UA });
      let reached = false;
      const res = await gate.run(req(c.path, { ...c, cookie }), ENV, undefined, () => {
        reached = true;
        return new Response('SITE CONTENT', { headers: { 'cache-control': 'public, max-age=600' } });
      });
      assert.equal(reached, true);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'SITE CONTENT');
      assert.equal(res.headers.get('vary'), 'Cookie');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=600');
    });
  }
});

describe('a pass stops working when it should', () => {
  test('different IP, host or user agent, tampering, expiry', async () => {
    const now = clock();
    const { gate } = makeGate({ now });
    const cookie = await passFor(gate);
    const ok = (o = {}) => gate.handle(req('/', { accept: HTML, cookie, ...o }), ENV);
    assert.equal(await ok(), null);
    assert.equal((await ok({ ip: '203.0.113.8' })).status, 403);
    assert.equal((await ok({ host: 'other.example.com' })).status, 403);
    assert.equal((await ok({ ua: 'Mozilla/5.0 Different' })).status, 403);
    const tampered = cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.equal((await ok({ cookie: tampered })).status, 403);
    now.advance(12 * 3600 * 1000 - 1000);
    assert.equal(await ok(), null);
    now.advance(2000);
    assert.equal((await ok()).status, 403);
  });

  test('a pass made with GATE_SECRET does not work after it changes, nor under the Turnstile-derived key', async () => {
    const { gate } = makeGate();
    const withGs = { ...ENV, GATE_SECRET: 'g'.repeat(40) };
    const cookie = await passFor(gate, { env: withGs });
    assert.equal(await gate.handle(req('/', { accept: HTML, cookie }), withGs), null);
    assert.equal((await gate.handle(req('/', { accept: HTML, cookie }), ENV)).status, 403);
    assert.equal((await gate.handle(req('/', { accept: HTML, cookie }), { ...ENV, GATE_SECRET: 'h'.repeat(40) })).status, 403);
  });

  test('rotating the Turnstile secret ends passes derived from it', async () => {
    const { gate } = makeGate();
    const cookie = await passFor(gate);
    const rotated = { ...ENV, TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecretKEYrotated000000' };
    assert.equal((await gate.handle(req('/', { accept: HTML, cookie }), rotated)).status, 403);
  });

  test('a huge or garbage Cookie header is just "no pass"', async () => {
    const { gate } = makeGate();
    const big = 'a=' + 'x'.repeat(40000) + `; ${PASS_COOKIE}=` + 'y'.repeat(3000);
    assert.equal((await gate.handle(req('/', { accept: HTML, cookie: big }), ENV)).status, 403);
    assert.equal((await gate.handle(req('/', { accept: HTML, cookie: `${PASS_COOKIE}=ÿþ;;=;` }), ENV)).status, 403);
    // One good pass among bad ones still works.
    const good = await passFor(gate);
    assert.equal(await gate.handle(req('/', { accept: HTML, cookie: `${PASS_COOKIE}=junk; ${good}` }), ENV), null);
  });

  test('the challenge reports why there was no pass', async () => {
    const events = [];
    const now = clock();
    const { gate } = makeGate({ now, onEvent: (t, d) => { events.push([t, d.reason]); } });
    const cookie = await passFor(gate);
    await gate.handle(req('/', { accept: HTML }), ENV);
    await gate.handle(req('/', { accept: HTML, cookie, ip: '198.51.100.9' }), ENV);
    now.advance(13 * 3600 * 1000);
    await gate.handle(req('/x.js', { cookie }), ENV);
    assert.deepEqual(events.filter(([t]) => t !== 'verify_ok'), [
      ['challenge_served', 'no_pass'], ['challenge_served', 'ip_changed'], ['blocked', 'expired'],
    ]);
  });
});

/* ------------------------------------------------------- verify endpoint -- */

describe('POST /__gate/verify', () => {
  test('success: siteverify with remoteip, signed cookie, 303 to the return path', async () => {
    const { gate, sv } = makeGate();
    const res = await gate.handle(verifyReq({ ret: '/scripts?x=1' }), ENV);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/scripts?x=1');
    assertGateHeaders(res);
    const set = res.headers.get('set-cookie');
    assert.match(set, new RegExp(`^${PASS_COOKIE}=v1\\.`));
    for (const attr of ['Path=/', 'Max-Age=43200', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(set.includes(attr), attr);
    assert.ok(!/Domain=/i.test(set), '__Host- cookies carry no Domain');
    assert.equal(sv.calls.length, 1);
    assert.equal(sv.calls[0].url, SITEVERIFY_URL);
    assert.deepEqual(sv.calls[0].params, { secret: ENV.TURNSTILE_SECRET_KEY, response: 'tok.en_-123', remoteip: IP });
  });

  test('works with no cookies at all and with the widget\'s own field name', async () => {
    const { gate } = makeGate();
    const r = req(VERIFY_PATH, {
      method: 'POST', accept: HTML,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'cf-turnstile-response=abc.def&return=%2F',
    });
    assert.equal(r.headers.get('cookie'), null);
    assert.equal((await gate.handle(r, ENV)).status, 303);
  });

  test('TURNSTILE_SECRET is accepted as an alias', async () => {
    const { gate, sv } = makeGate();
    const env = { TURNSTILE_SITE_KEY: ENV.TURNSTILE_SITE_KEY, TURNSTILE_SECRET: 'alias-secret-0x4AAAAAAAA' };
    assert.equal((await gate.handle(verifyReq(), env)).status, 303);
    assert.equal(sv.calls[0].params.secret, 'alias-secret-0x4AAAAAAAA');
  });

  test('pass lifetime comes from captcha_pass_hours, clamped to 1..168', async () => {
    for (const [value, maxAge] of [[2, 7200], ['24', 86400], [500, 168 * 3600], [0, 3600], [-5, 3600], ['abc', 43200], [null, 43200], [1.6, 7200]]) {
      const asked = [];
      const { gate } = makeGate({ getSetting: (k) => { asked.push(k); return value; } });
      const res = await gate.handle(verifyReq(), ENV);
      assert.match(res.headers.get('set-cookie'), new RegExp(`Max-Age=${maxAge};`), String(value));
      assert.deepEqual(asked, ['captcha_pass_hours']);
    }
    const { gate } = makeGate({ getSetting: () => { throw new Error('db down'); } });
    assert.match((await gate.handle(verifyReq(), ENV)).headers.get('set-cookie'), /Max-Age=43200;/);
  });

  const refusals = [
    ['siteverify says no', { answer: { success: false, 'error-codes': ['invalid-input-response'] } }, 'rejected', 403],
    ['token expired or reused', { answer: { success: false, 'error-codes': ['timeout-or-duplicate'] } }, 'rejected', 403, /expired/],
    ['hostname mismatch', { answer: { hostname: 'evil.example.com' } }, 'hostname_mismatch', 403],
    ['hostname missing', { answer: { hostname: undefined } }, 'hostname_mismatch', 403],
    ['wrong action', { answer: { action: 'login' } }, 'action_mismatch', 403],
    ['no action', { answer: { action: '' } }, 'action_mismatch', 403],
    ['siteverify network error', { answer: () => { throw new TypeError('fetch failed'); } }, 'network_error', 503, /couldn&#39;t reach/],
    ['siteverify HTTP 500', { answer: () => new Response('oops', { status: 500 }) }, 'siteverify_http', 503],
    ['siteverify not JSON', { answer: () => new Response('<html>', { status: 200 }) }, 'network_error', 503],
    ['siteverify "success": "true" (string)', { answer: { success: 'true' } }, 'rejected', 403],
  ];
  for (const [name, { answer }, reason, status, msg] of refusals) {
    test(`refused: ${name}`, async () => {
      const events = [];
      const { gate } = makeGate({ fetch: siteverify(answer), onEvent: (t, d) => events.push([t, d.reason]) });
      const res = await gate.handle(verifyReq({ ret: '/back' }), ENV);
      assert.equal(res.status, status);
      assert.equal(res.headers.get('set-cookie'), null, 'no pass on failure');
      assertGateHeaders(res);
      const html = await res.text();
      assert.match(html, /id="gate-error" role="alert">/, 'error state is shown');
      assert.match(html, /id="gate-retry">Try again</);
      assert.match(html, /data-ret="\/back"/);
      if (msg) assert.match(html, msg);
      assert.deepEqual(events, [['verify_failed', reason]]);
    });
  }

  test('refused without calling siteverify: missing, malformed, oversized and test tokens', async () => {
    for (const [token, reason] of [['', 'missing_token'], ['bad token with spaces', 'malformed_token'],
      ['x'.repeat(2049), 'malformed_token'], ['XXXX.DUMMY.TOKEN.XXXX', 'test_token'], ['1x00000000000000000000AA', 'test_token']]) {
      const events = [];
      const sv = siteverify();
      const { gate } = makeGate({ fetch: sv, onEvent: (t, d) => events.push(d.reason) });
      const res = await gate.handle(verifyReq({ token }), ENV);
      assert.equal(res.status, 403, token.slice(0, 20));
      assert.equal(sv.calls.length, 0);
      assert.deepEqual(events, [reason]);
    }
  });

  test('cross-origin posts, wrong content types and oversized bodies are refused', async () => {
    const sv = siteverify();
    const { gate } = makeGate({ fetch: sv });
    assert.equal((await gate.handle(verifyReq({ origin: 'https://evil.example' }), ENV)).status, 403);
    const json = req(VERIFY_PATH, { method: 'POST', accept: HTML, headers: { 'content-type': 'application/json' }, body: '{"token":"a"}' });
    assert.equal((await gate.handle(json, ENV)).status, 403);
    const big = req(VERIFY_PATH, { method: 'POST', accept: HTML, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=a&pad=' + 'x'.repeat(20000) });
    assert.equal((await gate.handle(big, ENV)).status, 403);
    assert.equal(sv.calls.length, 0);
    // Origin "null" and a missing Origin are allowed (privacy settings strip it).
    assert.equal((await gate.handle(verifyReq({ origin: 'null' }), ENV)).status, 303);
    assert.equal((await gate.handle(verifyReq({ origin: null }), ENV)).status, 303);
  });

  test('a script client gets JSON, not the page', async () => {
    const { gate } = makeGate({ fetch: siteverify({ success: false }) });
    const res = await gate.handle(verifyReq({ accept: 'application/json' }), ENV);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: 'captcha_failed', error: "That check didn't go through. Please try again." });
  });

  test('GET of the verify path goes home; other methods are refused', async () => {
    const { gate } = makeGate();
    const g = await gate.handle(req(VERIFY_PATH, { accept: HTML }), ENV);
    assert.equal(g.status, 303);
    assert.equal(g.headers.get('location'), '/');
    assert.equal((await gate.handle(req(VERIFY_PATH, { method: 'PUT', body: 'x' }), ENV)).status, 403);
  });

  test("Cloudflare's test secret is refused in production (fail closed), allowed on localhost", async () => {
    const testEnv = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
    const sv = siteverify({ hostname: 'example.com', action: '' });
    const { gate } = makeGate({ fetch: sv });
    for (const r of [req('/', { accept: HTML }), verifyReq({ token: 'XXXX.DUMMY.TOKEN.XXXX' })]) {
      const res = await gate.handle(r, testEnv);
      assert.equal(res.status, 503);
      assert.match(await res.text(), /test keys/);
    }
    // A real site key with the test secret, or the reverse, is just as closed.
    assert.equal((await gate.handle(req('/'), { ...ENV, TURNSTILE_SECRET_KEY: testEnv.TURNSTILE_SECRET_KEY })).status, 503);
    assert.equal((await gate.handle(req('/'), { ...ENV, TURNSTILE_SITE_KEY: '3x00000000000000000000FF' })).status, 503);
    assert.equal(sv.calls.length, 0);

    // Local dev: localhost from a loopback address.
    const local = { host: 'localhost:8787', ip: '127.0.0.1', origin: 'http://localhost:8787' };
    const page = await gate.handle(req('/', { ...local, accept: HTML, scheme: 'http' }), testEnv);
    assert.equal(page.status, 403);
    const v = await gate.handle(new Request(`http://localhost:8787${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '::1', 'user-agent': UA, accept: HTML },
      body: 'token=XXXX.DUMMY.TOKEN.XXXX&return=%2F',
    }), testEnv);
    assert.equal(v.status, 303, 'dummy token works in local dev');

    // "localhost" from a non-loopback address is a spoofed Host, not local dev.
    assert.equal((await gate.handle(req('/', { host: 'localhost', ip: '198.51.100.3', accept: HTML }), testEnv)).status, 503);
    // Nor is "localhost" with no client address at all (a runtime that forgot to set one).
    assert.equal((await gate.handle(req('/', { host: 'localhost', ip: null, accept: HTML, scheme: 'http' }), testEnv)).status, 503);
  });
});

/* ---------------------------------------------------------- return URL -- */

describe('open redirects', () => {
  const bad = ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'http://evil.com/', 'javascript:alert(1)',
    '/\t/evil.com', '/\n/evil.com', '/%0d%0aSet-Cookie:x', 'evil.com', '', '//', '/\\', ' /x', VERIFY_PATH,
    '/' + 'a'.repeat(3000), 'data:text/html,hi', '/\u0000', '/x\\y'];
  test('safeReturnPath sends anything off-site home', () => {
    for (const b of bad) {
      const out = safeReturnPath(b);
      assert.ok(out === '/' || (out.startsWith('/') && !out.startsWith('//') && !out.includes('\\')), JSON.stringify(b) + ' -> ' + out);
      if (b !== '/%0d%0aSet-Cookie:x') assert.equal(out, '/', JSON.stringify(b));
    }
    assert.equal(safeReturnPath('/%0d%0aSet-Cookie:x'), '/%0d%0aSet-Cookie:x', 'percent-encoded stays encoded');
    assert.equal(safeReturnPath('/a/b?c=1&d=%2F%2Fx#frag'), '/a/b?c=1&d=%2F%2Fx#frag');
    assert.equal(safeReturnPath('/a/../b'), '/b');
    assert.equal(safeReturnPath(undefined), '/');
    assert.equal(safeReturnPath(['/x']), '/');
  });

  test('the verify endpoint never redirects off-site', async () => {
    for (const b of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/\t/evil.com']) {
      const { gate } = makeGate();
      const res = await gate.handle(verifyReq({ ret: b }), ENV);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/', b);
    }
  });

  test('the challenge page carries the request path as the return path, escaped', async () => {
    const { gate } = makeGate();
    const res = await gate.handle(req('/search?q=%22%3E%3Cscript%3E', { accept: HTML }), ENV);
    const html = await res.text();
    assert.match(html, /name="return" value="\/search\?q=%22%3E%3Cscript%3E"/);
    const odd = await (await gate.handle(req('//evil.com/x', { accept: HTML }), ENV)).text();
    assert.match(odd, /name="return" value="\/"/);
  });
});

/* --------------------------------------------------------- fail closed -- */

describe('not configured = closed', () => {
  const cases = [
    ['no keys', {}],
    ['site key only', { TURNSTILE_SITE_KEY: ENV.TURNSTILE_SITE_KEY }],
    ['secret only', { TURNSTILE_SECRET_KEY: ENV.TURNSTILE_SECRET_KEY }],
    ['blank values', { TURNSTILE_SITE_KEY: '  ', TURNSTILE_SECRET_KEY: '' }],
    ['no env object', undefined],
  ];
  for (const [name, env] of cases) {
    test(name, async () => {
      const events = [];
      let asked = false;
      const { gate } = makeGate({ onEvent: (t) => events.push(t), exempt: () => { asked = true; return 'client'; } });
      for (const r of [req('/', { accept: HTML }), req('/robots.txt'), req('/api/x', { method: 'POST', body: '{}' }), verifyReq(), req('/client/heartbeat')]) {
        const res = await gate.handle(r, env);
        assert.equal(res.status, 503);
        assertGateHeaders(res);
        assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
        assert.equal(await res.text(), MSG_NOT_CONFIGURED);
      }
      assert.equal(asked, false, 'no exemption while closed');
      assert.deepEqual(events, ['misconfigured'], 'reported once, then throttled');
      assert.equal(gate.stats().totals.misconfigured, 5, 'but every one is counted');
    });
  }

  test('the exact message', () => {
    assert.equal(MSG_NOT_CONFIGURED, 'Not available: CAPTCHA is not configured (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY).');
  });

  test('HEAD gets the 503 without a body', async () => {
    const { gate } = makeGate();
    const res = await gate.handle(req('/', { method: 'HEAD' }), {});
    assert.equal(res.status, 503);
    assert.equal(await res.text(), '');
  });

  test('a short GATE_SECRET closes the gate instead of signing weak passes', async () => {
    const { gate } = makeGate();
    const res = await gate.handle(req('/', { accept: HTML }), { ...ENV, GATE_SECRET: 'short' });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /GATE_SECRET/);
  });
});

describe('internal errors fail closed', () => {
  test('a request the gate cannot read is a 503, never a pass', async () => {
    const { gate } = makeGate();
    const broken = {
      url: `https://${HOST}/`, method: 'GET',
      headers: { get: (name) => { if (name === 'cookie') throw new Error('boom'); return null; } },
    };
    const res = await gate.handle(broken, ENV);
    assert.equal(res.status, 503);
    assert.equal(await res.text(), 'Not available: the CAPTCHA gate failed.');
    assertGateHeaders(res);
    const bad = await gate.handle({ url: 'not a url', method: 'GET', headers: new Headers() }, ENV);
    assert.equal(bad.status, 503);
  });
});

describe('GATE_MODE="off" (break-glass)', () => {
  test('lets everything through, reports gate_off (throttled), counts every request', async () => {
    const events = [];
    const now = clock();
    const { gate, sv } = makeGate({ now, onEvent: (t) => events.push(t) });
    for (const mode of ['off', 'OFF', ' Off ']) {
      assert.equal(await gate.handle(req('/', { accept: HTML }), { ...ENV, GATE_MODE: mode }), null);
    }
    assert.equal(await gate.handle(req('/x.css'), { GATE_MODE: 'off' }), null, 'off even without keys');
    assert.deepEqual(events, ['gate_off']);
    now.advance(11 * 60 * 1000);
    await gate.handle(req('/'), { ...ENV, GATE_MODE: 'off' });
    assert.deepEqual(events, ['gate_off', 'gate_off']);
    assert.equal(gate.stats().totals.gate_off, 5);
    assert.equal(sv.calls.length, 0);
  });

  test('anything else means on', async () => {
    const { gate } = makeGate();
    for (const mode of ['on', 'false', '0', 'disabled', 'of', '']) {
      assert.equal((await gate.handle(req('/', { accept: HTML }), { ...ENV, GATE_MODE: mode })).status, 403, mode);
    }
  });
});

describe('gateStatus (console posture)', () => {
  test('on, off, not configured, misconfigured', () => {
    assert.deepEqual(
      [gateStatus(ENV).state, gateStatus(ENV).ok],
      ['on', true],
    );
    assert.match(gateStatus(ENV).detail, /derived from the Turnstile secret/);
    assert.match(gateStatus({ ...ENV, GATE_SECRET: 'g'.repeat(32) }).detail, /GATE_SECRET/);
    assert.equal(gateStatus({ ...ENV, GATE_MODE: 'off' }).state, 'off');
    assert.equal(gateStatus({ ...ENV, GATE_MODE: 'off' }).ok, false);
    assert.equal(gateStatus({}).state, 'not_configured');
    assert.equal(gateStatus(undefined).state, 'not_configured');
    assert.equal(gateStatus({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }).state, 'misconfigured');
    assert.equal(gateStatus({ ...ENV, GATE_SECRET: 'short' }).state, 'misconfigured');
  });
});

/* ----------------------------------------------------------- exemptions -- */

describe('exempt hook (machine clients)', () => {
  const exempt = (request, url, env) => {
    assert.ok(request instanceof Request);
    assert.ok(url instanceof URL);
    assert.equal(env.TURNSTILE_SITE_KEY, ENV.TURNSTILE_SITE_KEY);
    if (url.pathname.startsWith('/client/') && env.captcha_exempt_kidmonitor !== '0') return 'kidmonitor';
    if (url.pathname === '/async-client') return Promise.resolve('async');
    if (url.pathname === '/throws') throw new Error('settings unavailable');
    return null;
  };

  test('a named exemption passes without a pass and is reported', async () => {
    const events = [];
    const { gate } = makeGate({ exempt, onEvent: (t, d) => events.push([t, d.exemption]) });
    assert.equal(await gate.handle(req('/client/heartbeat', { method: 'POST', body: '{}' }), ENV), null);
    assert.equal(await gate.handle(req('/async-client'), ENV), null);
    assert.deepEqual(events, [['exempted', 'kidmonitor'], ['exempted', 'async']]);
  });

  test('turning the setting off puts the client behind the wall again', async () => {
    const { gate } = makeGate({ exempt });
    assert.equal((await gate.handle(req('/client/heartbeat'), { ...ENV, captcha_exempt_kidmonitor: '0' })).status, 403);
  });

  test('a hook that throws is not an exemption', async () => {
    const { gate } = makeGate({ exempt });
    assert.equal((await gate.handle(req('/throws'), ENV)).status, 403);
  });

  test('exemptionOf() names the exemption for that request only, and never for a pass', async () => {
    const { gate } = makeGate({ exempt });
    const ex = req('/client/heartbeat');
    assert.equal(await gate.handle(ex, ENV), null);
    assert.equal(gate.exemptionOf(ex), 'kidmonitor');
    assert.equal(gate.exemptionOf(req('/client/heartbeat')), null, 'another Request object');
    const blocked = req('/admin', { accept: HTML });
    assert.equal((await gate.handle(blocked, ENV)).status, 403);
    assert.equal(gate.exemptionOf(blocked), null);
    const cookie = await passFor(gate);
    const passed = req('/admin', { cookie });
    assert.equal(await gate.handle(passed, ENV), null);
    assert.equal(gate.exemptionOf(passed), null);
    assert.equal(gate.exemptionOf(null), null);
    assert.equal(gate.exemptionOf(undefined), null);
  });

  test('nothing else is exempt, and the verify path is never handed to the hook', async () => {
    let sawVerify = false;
    const { gate } = makeGate({ exempt: (_r, url) => { if (url.pathname === VERIFY_PATH) sawVerify = true; return url.pathname === VERIFY_PATH ? 'x' : null; } });
    assert.equal((await gate.handle(req('/', { accept: HTML }), ENV)).status, 403);
    assert.equal((await gate.handle(verifyReq(), ENV)).status, 303);
    assert.equal(sawVerify, false);
  });
});

/* -------------------------------------------------------------- caching -- */

describe('caching headers', () => {
  test('every gate response is no-store, private and noindex', async () => {
    const { gate } = makeGate({ fetch: siteverify({ success: false }) });
    const responses = [
      await gate.handle(req('/', { accept: HTML }), ENV),
      await gate.handle(req('/a.png'), ENV),
      await gate.handle(verifyReq(), ENV),
      await gate.handle(req(VERIFY_PATH), ENV),
      await gate.handle(req('/'), {}),
    ];
    const ok = makeGate();
    responses.push(await ok.gate.handle(verifyReq(), ENV));
    for (const r of responses) assertGateHeaders(r);
  });

  test('decorate makes passed responses private and Vary: Cookie', () => {
    const { gate } = makeGate();
    const cases = [
      [{}, 'private', 'Cookie'],
      [{ 'cache-control': 'public, max-age=31536000, immutable' }, 'private, max-age=31536000, immutable', 'Cookie'],
      [{ 'cache-control': 'max-age=60, s-maxage=3600, proxy-revalidate' }, 'private, max-age=60', 'Cookie'],
      [{ 'cache-control': 'no-store' }, 'no-store, private', 'Cookie'],
      [{ 'cache-control': 'private, no-cache' }, 'private, no-cache', 'Cookie'],
      [{ vary: 'Accept-Encoding' }, 'private', 'Accept-Encoding, Cookie'],
      [{ vary: 'Cookie, Accept' }, 'private', 'Cookie, Accept'],
      [{ vary: '*' }, 'private', '*'],
    ];
    for (const [headers, cc, vary] of cases) {
      const out = gate.decorate(new Response('x', { headers }));
      assert.equal(out.headers.get('cache-control'), cc, JSON.stringify(headers));
      assert.equal(out.headers.get('vary'), vary, JSON.stringify(headers));
    }
    assert.equal(privateCacheControl('Public, Max-Age=5'), 'private, Max-Age=5');
  });

  test('decorate drops CDN-only cache headers, which outrank Cache-Control at the CDN', () => {
    const { gate } = makeGate();
    const out = gate.decorate(new Response('x', {
      headers: {
        'cache-control': 'public, max-age=60',
        'CDN-Cache-Control': 'max-age=86400',
        'Cloudflare-CDN-Cache-Control': 'max-age=86400',
        'Akamai-CDN-Cache-Control': 'max-age=86400',
        'Surrogate-Control': 'max-age=86400',
        'X-Accel-Expires': '86400',
        'x-cdn-cache-control-note': 'kept',
      },
    }));
    assert.equal(out.headers.get('cache-control'), 'private, max-age=60');
    for (const h of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'akamai-cdn-cache-control', 'surrogate-control', 'x-accel-expires']) {
      assert.equal(out.headers.get(h), null, h);
    }
    assert.equal(out.headers.get('x-cdn-cache-control-note'), 'kept');
    const immutable = Response.redirect('https://portal.example.com/x', 302);
    const wrapped = new Response(null, { status: 302, headers: { location: '/x', 'cdn-cache-control': 'max-age=60' } });
    assert.equal(gate.decorate(wrapped).headers.get('cdn-cache-control'), null);
    assert.equal(gate.decorate(immutable).headers.get('cdn-cache-control'), null);
    assert.equal(isSharedCacheHeader('Surrogate-Control'), true);
    assert.equal(isSharedCacheHeader('Cache-Control'), false);
  });

  test('decorate re-wraps a response whose headers are immutable', async () => {
    const { gate } = makeGate();
    const redirect = Response.redirect('https://portal.example.com/x', 302);
    assert.throws(() => redirect.headers.set('x', '1'));
    const out = gate.decorate(redirect);
    assert.equal(out.status, 302);
    assert.equal(out.headers.get('location'), 'https://portal.example.com/x');
    assert.equal(out.headers.get('vary'), 'Cookie');
  });

  test('decorate leaves a WebSocket upgrade alone', () => {
    const { gate } = makeGate();
    const fake = { status: 101, webSocket: {}, headers: new Headers() };
    assert.equal(gate.decorate(fake), fake);
    assert.equal(fake.headers.get('vary'), null);
  });
});

/* ------------------------------------------------------- events & stats -- */

describe('events and counters', () => {
  test('hooks get type, detail and env; promises go to ctx.waitUntil; a throwing hook changes nothing', async () => {
    const seen = [];
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    const { gate } = makeGate({
      onEvent: (type, detail, env) => {
        seen.push({ type, detail, envOk: env === ENV });
        if (type === 'blocked') throw new Error('hook bug');
        return Promise.resolve();
      },
    });
    await gate.handle(req('/', { accept: HTML, headers: { 'cf-ipcountry': 'US' } }), ENV, ctx);
    const blocked = await gate.handle(req('/x.css'), ENV, ctx);
    assert.equal(blocked.status, 403);
    assert.equal(seen[0].type, 'challenge_served');
    assert.equal(seen[0].envOk, true);
    assert.deepEqual(
      { ip: seen[0].detail.ip, host: seen[0].detail.host, path: seen[0].detail.path, method: seen[0].detail.method, country: seen[0].detail.country, hour: seen[0].detail.hour },
      { ip: IP, host: HOST, path: '/', method: 'GET', country: 'US', hour: '2026-11-12T12' },
    );
    assert.equal(waited.length, 1);
  });

  test('onStats gets batched hourly counts at most once per interval, and retries a failed flush', async () => {
    const now = clock();
    const batches = [];
    let failNext = false;
    const { gate } = makeGate({
      now, statsFlushSeconds: 60,
      onStats: async (rows) => {
        if (failNext) { failNext = false; throw new Error('d1 busy'); }
        batches.push(rows);
      },
    });
    for (let i = 0; i < 5; i++) await gate.handle(req('/', { accept: HTML }), ENV);
    await gate.handle(req('/a.js'), ENV);
    assert.equal(batches.length, 0, 'nothing before the interval');
    now.advance(61000);
    await gate.handle(req('/b.js'), ENV);
    await new Promise((r) => setImmediate(r));
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].sort((a, b) => a.event.localeCompare(b.event)), [
      { hour: '2026-11-12T12', event: 'blocked', count: 2 },
      { hour: '2026-11-12T12', event: 'challenge_served', count: 5 },
    ]);
    failNext = true;
    await gate.handle(req('/c.js'), ENV);
    now.advance(61000);
    await gate.handle(req('/d.js'), ENV);
    await new Promise((r) => setImmediate(r));
    assert.equal(batches.length, 1, 'that flush failed');
    await gate.flushStats(ENV);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1], [{ hour: '2026-11-12T12', event: 'blocked', count: 2 }]);
    assert.equal(gate.stats().totals.blocked, 4);
  });

  test("stats().since is the first request, not module load (workerd's clock reads 0 at module scope)", async () => {
    let t = 0; // what Date.now() returns while a Worker's module is evaluated
    const batches = [];
    const gate = createGate({
      siteName: 'X', fetch: siteverify(), now: () => t, statsFlushSeconds: 60,
      onStats: (rows) => { batches.push(rows); },
    });
    t = T0 + 5000;
    await gate.handle(req('/', { accept: HTML }), ENV);
    assert.equal(gate.stats().since, new Date(T0 + 5000).toISOString());
    await new Promise((r) => setImmediate(r));
    assert.equal(batches.length, 0, 'the first flush waits a full interval, as on Node');
    t += 61000;
    await gate.handle(req('/', { accept: HTML }), ENV);
    await new Promise((r) => setImmediate(r));
    assert.equal(batches.length, 1);
    assert.equal(gate.stats().since, new Date(T0 + 5000).toISOString(), 'since does not move');
    // stats() before any request reports the time it was asked, never 1970.
    let u = 0;
    const idle = createGate({ siteName: 'Y', now: () => u });
    u = T0;
    assert.equal(idle.stats().since, new Date(T0).toISOString());
  });

  test('stats() counts passes, verifies and exemptions', async () => {
    const { gate } = makeGate({ exempt: (_r, u) => (u.pathname === '/m' ? 'machine' : null), fetch: siteverify() });
    const cookie = await passFor(gate);
    await gate.handle(req('/', { cookie }), ENV);
    await gate.handle(req('/m'), ENV);
    const failing = createGate({ siteName: 'x', fetch: siteverify({ success: false }) });
    await failing.handle(verifyReq(), ENV);
    assert.deepEqual(gate.stats().totals, { verify_ok: 1, passed: 1, exempted: 1 });
    assert.deepEqual(failing.stats().totals, { verify_failed: 1 });
  });
});

/* ------------------------------------------------------ challenge page -- */

describe('challenge page', () => {
  test('strict CSP with a fresh nonce; only Turnstile is loaded; no inline style attributes', async () => {
    const { gate } = makeGate();
    const a = await gate.handle(req('/', { accept: HTML }), ENV);
    const b = await gate.handle(req('/', { accept: HTML }), ENV);
    const csp = a.headers.get('content-security-policy');
    const nonce = /'nonce-([A-Za-z0-9_-]{22})'/.exec(csp)[1];
    assert.notEqual(nonce, /'nonce-([A-Za-z0-9_-]{22})'/.exec(b.headers.get('content-security-policy'))[1]);
    assert.equal(csp, [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
      'frame-src https://challenges.cloudflare.com',
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self' https://challenges.cloudflare.com",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    assert.equal(a.headers.get('x-frame-options'), 'DENY');
    const html = await a.text();
    const scripts = html.match(/<script\b[^>]*>/g);
    assert.equal(scripts.length, 2);
    for (const s of scripts) assert.equal(s, `<script nonce="${nonce}">`);
    assert.equal(html.match(/<style\b[^>]*>/g).join(), `<style nonce="${nonce}">`);
    assert.doesNotMatch(html, /\sstyle="/);
    assert.doesNotMatch(html, /\son[a-z]+="/, 'no inline event handlers');
    assert.doesNotMatch(html, /<(link|img|iframe)\b/);
    const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
    for (const u of urls) assert.ok(u.startsWith('https://challenges.cloudflare.com/') || u === 'https://challenges.cloudflare.com', u);
    assert.ok(html.includes(`data-api="${TURNSTILE_API}?render=explicit&amp;onload=__gateTurnstileReady"`));
  });

  test('content: site name and domain, the line, the widget, noscript, live region, retry', async () => {
    const { gate } = makeGate({ siteDomain: 'portal.example.com' });
    const html = await (await gate.handle(req('/', { accept: HTML, host: 'preview.workers.dev' }), ENV)).text();
    assert.match(html, /<p class="g-domain">portal\.example\.com<\/p>/);
    assert.match(html, /<h1 id="gate-title">Example Portal<\/h1>/);
    assert.match(html, /<p class="g-line">Checking that you're human before loading Example Portal\.<\/p>/);
    assert.match(html, /<form id="gate-form" method="post" action="\/__gate\/verify"/);
    assert.match(html, new RegExp(`data-sitekey="${ENV.TURNSTILE_SITE_KEY}"`));
    assert.match(html, /<noscript>.*JavaScript is required/s);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(html, /id="gate-error" role="alert" hidden>/);
    assert.match(html, /action: 'gate'/);
    assert.match(html, /form\.submit\(\)/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /prefers-color-scheme:dark/);
  });

  test('the domain defaults to the request host', async () => {
    const { gate } = makeGate();
    const html = await (await gate.handle(req('/', { accept: HTML }), ENV)).text();
    assert.match(html, /<p class="g-domain">portal\.example\.com<\/p>/);
  });

  test('site name, domain and key are escaped', () => {
    const html = renderChallengePage({
      siteName: '<img src=x onerror=alert(1)>&"', siteDomain: '"><script>x</script>', siteKey: '"key', nonce: 'n"o', returnPath: '/"><x',
    });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /"><script>x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;/);
    assert.match(html, /data-sitekey="&quot;key"/);
    assert.match(html, /nonce="n&quot;o"/);
  });
});

/* ------------------------------------------- challenge page, behaviour -- */

// Runs the page's own script against a small stand-in DOM, so its states can
// be checked without a browser (demo/screenshots.mjs looks at the real thing).
function runChallengeScript({ error = '' } = {}) {
  const html = renderChallengePage({ siteName: 'Example', siteDomain: 'example.com', siteKey: 'k', nonce: 'n', returnPath: '/x', error });
  const code = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((c) => c.includes('gate-form'));
  const el = (id, extra = {}) => ({
    id, hidden: false, textContent: '', className: '', value: '', clientWidth: 320, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {}, ...extra,
  });
  const card = { className: error ? 'g-card g-failed' : 'g-card' };
  const els = {
    'gate-form': el('gate-form', { parentNode: card, dataset: { sitekey: 'k', site: 'Example', ret: '/x', api: 'https://challenges.cloudflare.com/api.js', failed: error ? '1' : '0' }, submit() { this.submitted = true; } }),
    'gate-widget': el('gate-widget', { hidden: Boolean(error) }),
    'gate-status': el('gate-status'),
    'gate-error': el('gate-error', { hidden: !error }),
    'gate-error-text': el('gate-error-text'),
    'gate-retry': el('gate-retry'),
    'gate-token': el('gate-token'),
  };
  const scripts = [];
  const timers = [];
  const replaced = [];
  const win = { addEventListener() {} };
  vm.runInNewContext(code, {
    window: win,
    document: { getElementById: (id) => els[id], createElement: () => ({}), head: { appendChild: (x) => scripts.push(x) } },
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }),
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    location: { replace: (u) => replaced.push(u), reload() {} },
    history: { replaceState() {} },
  });
  return { els, scripts, timers, win, replaced, card, box: els['gate-widget'], err: els['gate-error'], status: els['gate-status'] };
}

describe('challenge page behaviour', () => {
  test('script blocked: the empty widget box is hidden, so no blank gap sits above the error', () => {
    const p = runChallengeScript();
    assert.equal(p.box.hidden, false);
    assert.equal(p.scripts.length, 1);
    p.scripts[0].onerror();
    assert.equal(p.err.hidden, false);
    assert.match(p.els['gate-error-text'].textContent, /could not load/);
    assert.equal(p.box.hidden, true, 'nothing was drawn, so no 65px placeholder');
    assert.equal(p.card.className, 'g-card g-failed', 'the same tight layout as the failed-verify page');
    assert.equal(p.status.textContent, '');
    // "Try again" shows the box again (and reloads, since the script was requested).
    p.els['gate-retry'].listeners.click();
    assert.equal(p.box.hidden, false);
    assert.equal(p.card.className, 'g-card');
    assert.deepEqual(p.replaced, ['/x']);
  });

  test('load timeout hides the box; a script that arrives late recovers by itself', () => {
    const p = runChallengeScript();
    const t = p.timers.find((x) => x.ms === 20000);
    t.fn();
    assert.equal(p.box.hidden, true);
    assert.match(p.els['gate-error-text'].textContent, /taking too long/);
    let rendered = null;
    p.win.turnstile = { render: (box, opts) => { rendered = { box, opts }; return 'w1'; }, reset() {} };
    p.win.__gateTurnstileReady();
    assert.equal(p.err.hidden, true);
    assert.equal(p.box.hidden, false);
    assert.equal(p.card.className, 'g-card');
    assert.equal(rendered.box, p.box);
    assert.equal(rendered.opts.action, 'gate');
  });

  test('a widget that rendered keeps its box when it reports an error (Turnstile draws its own state there)', () => {
    const p = runChallengeScript();
    let opts = null;
    p.win.turnstile = { render: (_box, o) => { opts = o; return 'w1'; }, reset() {} };
    p.win.__gateTurnstileReady();
    opts['error-callback']();
    assert.equal(p.err.hidden, false);
    assert.equal(p.box.hidden, false);
    opts.callback('tok');
    assert.equal(p.els['gate-token'].value, 'tok');
    assert.equal(p.els['gate-form'].submitted, true);
  });

  test('render() throwing counts as nothing drawn', () => {
    const p = runChallengeScript();
    p.win.turnstile = { render: () => { throw new Error('bad sitekey'); } };
    p.win.__gateTurnstileReady();
    assert.equal(p.err.hidden, false);
    assert.equal(p.box.hidden, true);
  });

  test('the failed-verify state waits for "Try again" with the box hidden', () => {
    const p = runChallengeScript({ error: 'That check did not go through.' });
    assert.equal(p.scripts.length, 0);
    assert.equal(p.box.hidden, true);
    p.els['gate-retry'].listeners.click();
    assert.equal(p.box.hidden, false);
    assert.equal(p.card.className, 'g-card', 'the widget gets its usual spacing back');
    assert.equal(p.scripts.length, 1);
  });

  test('the widget gets the full-width (>= 300px) Turnstile size at every phone width from 350px up', () => {
    // Recompute the widget box from the page's own CSS: viewport minus the
    // body gutter, capped by the card's max-width, minus card padding and border.
    const css = /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec(renderChallengePage({ siteName: 'x', siteDomain: 'x', siteKey: 'k', nonce: 'n' }))[1];
    const side = (decl) => { const v = decl.trim().split(/\s+/).map((x) => parseFloat(x)); return v.length >= 2 ? v[1] : v[0]; };
    const base = {
      body: side(/body\{[^}]*?padding:([^;}]+)/.exec(css)[1]),
      card: side(/\.g-card\{[^}]*?padding:([^;}]+)/.exec(css)[1]),
      max: parseFloat(/\.g-card\{[^}]*?max-width:(\d+)px/.exec(css)[1]),
    };
    const media = [...css.matchAll(/@media \(max-width:(\d+)px\)\{([\s\S]*?)\n\}/g)].map((m) => ({
      max: Number(m[1]),
      body: /body\{[^}]*?padding:([^;}]+)/.exec(m[2]),
      card: /\.g-card\{[^}]*?padding:([^;}]+)/.exec(m[2]),
    }));
    const widgetBox = (w) => {
      let body = base.body, card = base.card;
      for (const m of media) if (w <= m.max) { if (m.body) body = side(m.body[1]); if (m.card) card = side(m.card[1]); }
      return Math.min(base.max, w - 2 * body) - 2 * card - 2;
    };
    assert.equal(widgetBox(390), 312, 'matches the measured 390px layout');
    for (let w = 350; w <= 1600; w++) assert.ok(widgetBox(w) >= 300, `${w}px viewport: widget box ${widgetBox(w)}px`);
    assert.ok(widgetBox(375) >= 300, '375px iPhones');
  });
});

/* ---------------------------------------------------------- d.ts files -- */

function findTsc() {
  if (process.env.TSC) return process.env.TSC;
  try { return path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc'); } catch { return ''; }
}

/** The @types directory holding @types/node, looked up from the kit and from TypeScript's own install. */
function findTypeRoots(tsc) {
  for (const from of [import.meta.url, tsc]) {
    if (!from) continue;
    try { return path.dirname(path.dirname(createRequire(from).resolve('@types/node/package.json'))); } catch { /* next */ }
  }
  return '';
}

describe('type declarations', () => {
  test('gate.d.ts and gate.d.mts (and the node pair) are identical', () => {
    const read = (f) => readFileSync(path.join(here, '..', f), 'utf8');
    assert.equal(read('gate.d.ts'), read('gate.d.mts'));
    assert.equal(read('gate-node.d.ts'), read('gate-node.d.mts'));
  });

  test('every runtime export is declared', async () => {
    const mod = await import('../gate.mjs');
    const dts = readFileSync(path.join(here, '..', 'gate.d.ts'), 'utf8');
    for (const name of Object.keys(mod)) assert.match(dts, new RegExp(`export declare (const|function) ${name}\\b`), name);
    const nodeMod = await import('../gate-node.mjs');
    const nodeDts = readFileSync(path.join(here, '..', 'gate-node.d.ts'), 'utf8');
    for (const name of Object.keys(nodeMod)) assert.match(nodeDts, new RegExp(`export declare (const|function) ${name}\\b`), name);
  });

  test('the declarations lean on no DOM-only global (a Node-only project has no CryptoKey)', () => {
    for (const f of ['gate.d.ts', 'gate-node.d.ts']) {
      const code = readFileSync(path.join(here, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /\b(CryptoKey|KeyAlgorithm|Window|Document|HTMLElement|Element|Navigator)\b/, f);
    }
  });

  test('a strict TypeScript Worker compiles against them (skipped without TypeScript)', (t) => {
    const tsc = findTsc();
    if (!tsc) { t.skip('TypeScript not found (set TSC=/path/to/tsc)'); return; }
    const r = spawnSync(process.execPath, [tsc, '-p', path.join(here, 'types', 'tsconfig.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('a strict Node-only TypeScript server (no DOM lib, skipLibCheck off) compiles against them (skipped without TypeScript or @types/node)', (t) => {
    const tsc = findTsc();
    const roots = findTypeRoots(tsc);
    if (!tsc || !roots) { t.skip('TypeScript or @types/node not found (set TSC=/path/to/tsc)'); return; }
    const r = spawnSync(process.execPath, [tsc, '-p', path.join(here, 'types', 'tsconfig.node.json'), '--typeRoots', roots], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

/* ------------------------------------------------------------ vendoring -- */

describe('vendoring', () => {
  test("vendored under src/, the kit passes repo grep invariants (KidMonitor's scripts/ci-grep-gates.sh)", () => {
    const root = path.join(here, '..');
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'screenshots') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(path.relative(root, p));
      }
    };
    walk(root);
    // KidMonitor scans *.ts, *.tsx and *.js under src/; the runtime files are
    // held to the same rules in case another repo scans .mjs/.mts too.
    const scanned = files.filter((f) => /\.(ts|tsx|js)$/.test(f) || /^gate(-node)?\.(mjs|d\.mts)$/.test(f));
    assert.ok(scanned.includes('test/types/worker.ts') && scanned.includes('gate.mjs'), scanned.join(','));
    const forbidden = [
      [/\.prepare\(/, '.prepare( (D1) outside the repo db module'],
      [/console\.(log|error|warn)/, 'console.log/error/warn'],
      [/AES-GCM|PBKDF2|HKDF|crypto\.subtle\.decrypt|deriveBits/, 'browser-only crypto primitives'],
    ];
    for (const f of scanned) {
      const text = readFileSync(path.join(root, f), 'utf8');
      for (const [re, what] of forbidden) {
        const line = text.split('\n').findIndex((l) => re.test(l));
        assert.equal(line, -1, `${f}:${line + 1} uses ${what}`);
      }
    }
  });
});

/* -------------------------------------------------------- Node adapter -- */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function raw(port, { method = 'GET', path: p = '/', headers = {}, body, socketPath } = {}) {
  return new Promise((resolve, reject) => {
    const where = socketPath ? { socketPath } : { host: '127.0.0.1', port };
    const r = http.request({ ...where, agent: false, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, message: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const FORM = 'application/x-www-form-urlencoded';
const TEST_ENV = Object.freeze({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });
const DUMMY = 'XXXX.DUMMY.TOKEN.XXXX';

describe('Node adapter (real http server)', () => {
  // The app sits behind a reverse proxy on loopback that overwrites
  // CF-Connecting-IP with the visitor's address (INTEGRATION.md 4(c)), so the
  // default here trusts that header from 127.0.0.1 / ::1 only.
  async function serve(options = {}, { env = ENV, gateOptions = {}, peer, app } = {}) {
    const sv = gateOptions.fetch || siteverify({ hostname: 'portal.example.com' });
    const gate = createGate({ siteName: 'Example Portal', fetch: sv, ...gateOptions });
    const nodeGate = createNodeGate(gate, { env, trustCloudflare: ['127.0.0.1', '::1'], ...options });
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const fake = typeof peer === 'function' ? peer() : peer;
      if (fake !== undefined) Object.defineProperty(req.socket, 'remoteAddress', { value: fake, configurable: true });
      if (await nodeGate(req, res)) return;
      let body = '';
      for await (const c of req) body += c;
      seen.push({ url: req.url, body });
      if (app) { app(req, res, body); return; }
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('Content-Type', 'text/plain');
      res.end('SITE ' + req.method + ' ' + req.url + ' ' + body);
    });
    const port = await listen(server);
    return { server, port, sv, seen };
  }
  const H = { host: 'portal.example.com', 'user-agent': UA, 'cf-connecting-ip': IP };
  const verifyBody = (ret = '/') => `token=abc.def&return=${encodeURIComponent(ret)}`;
  async function passOn(port, headers = H) {
    const v = await raw(port, { method: 'POST', path: VERIFY_PATH, headers: { ...headers, accept: HTML, 'content-type': FORM }, body: verifyBody() });
    assert.equal(v.status, 303, v.body);
    return v.headers['set-cookie'][0].split(';')[0];
  }

  test('blocks, verifies, then serves the site privately', async (t) => {
    const { server, port, sv, seen } = await serve();
    t.after(() => server.close());
    const page = await raw(port, { headers: { ...H, accept: HTML } });
    assert.equal(page.status, 403);
    assert.match(page.body, /Checking that you're human/);
    assert.equal(page.headers['cache-control'], 'no-store, private');
    const asset = await raw(port, { path: '/robots.txt', headers: H });
    assert.equal(asset.status, 403);
    assert.equal(JSON.parse(asset.body).code, 'captcha_required');
    const head = await raw(port, { method: 'HEAD', headers: { ...H, accept: HTML } });
    assert.equal(head.status, 403);
    assert.equal(head.body, '');

    const v = await raw(port, {
      method: 'POST', path: VERIFY_PATH,
      headers: { ...H, accept: HTML, origin: 'https://portal.example.com', 'content-type': FORM },
      body: 'token=abc.def&return=%2Fhello%3Fa%3D1',
    });
    assert.equal(v.status, 303);
    assert.equal(v.headers.location, '/hello?a=1');
    assert.equal(sv.calls[0].params.remoteip, IP, "the visitor's address, from the trusted proxy");
    const cookie = v.headers['set-cookie'][0].split(';')[0];
    assert.equal(seen.length, 0, 'the app never ran');

    const ok = await raw(port, { path: '/hello?a=1', headers: { ...H, cookie } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'SITE GET /hello?a=1 ');
    assert.equal(ok.headers.vary, 'Cookie');
    assert.equal(ok.headers['cache-control'], 'private, max-age=60');

    const post = await raw(port, { method: 'POST', path: '/api/echo', headers: { ...H, cookie, 'content-type': 'application/json' }, body: '{"keep":"me"}' });
    assert.equal(post.body, 'SITE POST /api/echo {"keep":"me"}', "the app's body stream is untouched");
  });

  test('spoofed CF-Connecting-IP and X-Forwarded-For from an untrusted peer are ignored', async (t) => {
    for (const trustCloudflare of [false, ['127.0.0.1', '::1']]) {
      const { server, port, sv } = await serve({ trustCloudflare }, { peer: '198.51.100.20' });
      t.after(() => server.close());
      const v = await raw(port, {
        method: 'POST', path: VERIFY_PATH,
        headers: { ...H, accept: HTML, 'cf-connecting-ip': '198.51.100.66', 'x-forwarded-for': '198.51.100.77', 'content-type': FORM },
        body: verifyBody(),
      });
      assert.equal(v.status, 303);
      assert.equal(sv.calls[0].params.remoteip, '198.51.100.20', 'the socket address');
      const cookie = v.headers['set-cookie'][0].split(';')[0];
      // The pass is bound to the socket address, so a different spoofed header changes nothing.
      const ok = await raw(port, { headers: { ...H, cookie, 'cf-connecting-ip': '1.2.3.4' } });
      assert.equal(ok.status, 200);
    }
  });

  test('trustCloudflare: true uses CF-Connecting-IP; a peer list trusts it only from those peers ("unix": a Unix socket)', async (t) => {
    const a = await serve({ trustCloudflare: true });
    t.after(() => a.server.close());
    await raw(a.port, {
      method: 'POST', path: VERIFY_PATH,
      headers: { ...H, accept: HTML, 'cf-connecting-ip': '2001:DB8::5', 'content-type': FORM },
      body: verifyBody(),
    });
    assert.equal(a.sv.calls[0].params.remoteip, '2001:db8::5');

    const fakeReq = (remoteAddress, cfip, server) => ({ socket: { remoteAddress, server }, headers: { 'cf-connecting-ip': cfip } });
    assert.equal(clientIpOf(fakeReq('::ffff:127.0.0.1', '203.0.113.1'), { trustCloudflare: ['127.0.0.1'] }), '203.0.113.1');
    assert.equal(clientIpOf(fakeReq('198.51.100.2', '203.0.113.1'), { trustCloudflare: ['127.0.0.1'] }), '198.51.100.2');
    assert.equal(clientIpOf(fakeReq('198.51.100.2', '203.0.113.1')), '198.51.100.2');
    assert.equal(clientIpOf(fakeReq('198.51.100.2', undefined), { trustCloudflare: true }), '198.51.100.2');
    const unixServer = { address: () => '/run/app.sock' };
    assert.equal(clientIpOf(fakeReq(undefined, '203.0.113.1', unixServer), { trustCloudflare: ['unix'] }), '203.0.113.1');
    assert.equal(clientIpOf(fakeReq(undefined, '203.0.113.1', unixServer), { trustCloudflare: ['127.0.0.1'] }), '');
    assert.equal(clientIpOf(fakeReq(undefined, '203.0.113.1', unixServer), { trustCloudflare: ['127.0.0.1', ''] }), '', 'an empty entry never matches');
    assert.equal(clientIpOf(fakeReq(undefined, '203.0.113.1', { address: () => ({ port: 1 }) }), { trustCloudflare: ['unix'] }), '', 'TCP socket that lost its peer');
  });

  test('behind a proxy with no trust configured: 503, never one pass shared by every visitor', async (t) => {
    const { server, port, sv, seen } = await serve({ trustCloudflare: false });
    t.after(() => server.close());
    for (const r of [
      { headers: { ...H, accept: HTML } },
      { path: '/admin/anything', headers: H },
      { method: 'POST', path: VERIFY_PATH, headers: { ...H, accept: HTML, 'content-type': FORM }, body: verifyBody() },
    ]) {
      const res = await raw(port, r);
      assert.equal(res.status, 503);
      assert.equal(res.body, MSG_PRIVATE_CLIENT);
      assert.equal(res.headers['cache-control'], 'no-store, private');
      assert.match(res.headers['x-robots-tag'], /noindex/);
    }
    assert.equal(sv.calls.length, 0);
    assert.equal(seen.length, 0);
  });

  test('a trusted proxy that sends no CF-Connecting-IP: 503 (it would put everyone on its own address)', async (t) => {
    const { server, port } = await serve();
    t.after(() => server.close());
    const { 'cf-connecting-ip': _drop, ...noIp } = H;
    const res = await raw(port, { headers: { ...noIp, accept: HTML, 'x-forwarded-for': '198.51.100.1' } });
    assert.equal(res.status, 503);
    assert.equal(res.body, MSG_PRIVATE_CLIENT);
  });

  test('private, CGNAT, link-local and ULA peers are refused like loopback; a public peer gets the challenge', async (t) => {
    let current = '';
    const { server, port } = await serve({ trustCloudflare: false }, { peer: () => current });
    t.after(() => server.close());
    for (const p of ['10.0.0.5', '172.17.0.1', '192.168.1.10', '100.64.1.1', '169.254.1.1', 'fd00::1', 'fe80::1', '::1']) {
      current = p;
      const res = await raw(port, { headers: { ...H, accept: HTML } });
      assert.equal(res.status, 503, p);
    }
    current = '198.51.100.9';
    assert.equal((await raw(port, { headers: { ...H, accept: HTML } })).status, 403);
  });

  test('the documented reverse proxy (overwrites CF-Connecting-IP): one solve unlocks only the visitor who solved it', async (t) => {
    const app = await serve();
    // Stand-in for Caddy `header_up CF-Connecting-IP {remote_host}` / nginx
    // `proxy_set_header CF-Connecting-IP $remote_addr`: whatever the client
    // sent is replaced by the address it connected from (simulated here).
    const proxy = http.createServer((req, res) => {
      const headers = { ...req.headers, 'cf-connecting-ip': req.headers['x-sim-client'], 'x-forwarded-for': req.headers['x-sim-client'] };
      delete headers['x-sim-client'];
      const up = http.request({ host: '127.0.0.1', port: app.port, method: req.method, path: req.url, headers, agent: false }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      req.pipe(up);
    });
    const pport = await listen(proxy);
    t.after(() => { proxy.close(); app.server.close(); });
    const via = (client, extra = {}) => ({ host: 'portal.example.com', 'user-agent': UA, 'x-sim-client': client, ...extra });
    const v = await raw(pport, { method: 'POST', path: VERIFY_PATH, headers: via('198.51.100.1', { accept: HTML, 'content-type': FORM }), body: verifyBody() });
    assert.equal(v.status, 303);
    assert.equal(app.sv.calls[0].params.remoteip, '198.51.100.1');
    const cookie = v.headers['set-cookie'][0].split(';')[0];
    for (const bot of ['203.0.113.5', '2001:db8::77', '100.64.9.9']) {
      // Even a bot that claims the solver's address in its own CF-Connecting-IP.
      const r = await raw(pport, { path: '/admin/anything', headers: via(bot, { cookie, 'cf-connecting-ip': '198.51.100.1' }) });
      assert.notEqual(r.status, 200, bot);
    }
    assert.equal((await raw(pport, { path: '/admin/anything', headers: via('198.51.100.1', { cookie }) })).status, 200);
    assert.equal(app.sv.calls.length, 1);
  });

  test('a Unix-socket listener is closed unless "unix" is trusted', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-kit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const start = async (trustCloudflare, name) => {
      const sv = siteverify({ hostname: 'portal.example.com' });
      const nodeGate = createNodeGate(createGate({ siteName: 'X', fetch: sv }), { env: ENV, trustCloudflare });
      const server = http.createServer(async (req, res) => { if (!(await nodeGate(req, res))) res.end('SITE'); });
      const socketPath = path.join(dir, name);
      await new Promise((r) => server.listen(socketPath, r));
      t.after(() => server.close());
      return { sv, socketPath };
    };
    const closed = await start(false, 'a.sock');
    const r = await raw(0, { socketPath: closed.socketPath, headers: { ...H, accept: HTML } });
    assert.equal(r.status, 503);
    assert.equal(r.body, MSG_PRIVATE_CLIENT);

    const open = await start(['unix'], 'b.sock');
    const v = await raw(0, { socketPath: open.socketPath, method: 'POST', path: VERIFY_PATH, headers: { ...H, accept: HTML, 'content-type': FORM }, body: verifyBody() });
    assert.equal(v.status, 303);
    assert.equal(open.sv.calls[0].params.remoteip, IP);
    const cookie = v.headers['set-cookie'][0].split(';')[0];
    assert.equal((await raw(0, { socketPath: open.socketPath, headers: { ...H, cookie } })).body, 'SITE');
  });

  test('test keys need localDev, a loopback socket and Host, and no proxy headers', async (t) => {
    const sv = siteverify({ hostname: 'example.com', action: '' });
    // A production box that shipped test keys, behind a proxy that forwards the client's Host.
    const prod = await serve({ trustCloudflare: false }, { env: TEST_ENV, gateOptions: { fetch: sv } });
    t.after(() => prod.server.close());
    const L = (port, extra = {}) => ({ host: `localhost:${port}`, 'user-agent': UA, ...extra });
    for (const host of ['localhost', `localhost:${prod.port}`, 'portal.example.com']) {
      const page = await raw(prod.port, { path: '/admin', headers: { ...L(prod.port), host, accept: HTML } });
      assert.equal(page.status, 503, host);
      assert.equal(page.body, MSG_TEST_KEYS);
      const v = await raw(prod.port, { method: 'POST', path: VERIFY_PATH, headers: { ...L(prod.port), host, accept: HTML, 'content-type': FORM }, body: `token=${DUMMY}&return=%2Fadmin` });
      assert.equal(v.status, 503, host);
      assert.equal(v.headers['set-cookie'], undefined);
    }
    assert.equal(sv.calls.length, 0);

    // A developer's machine: localDev on, loopback socket, loopback Host, no proxy headers.
    let peer = '127.0.0.1';
    const dev = await serve({ trustCloudflare: false, localDev: true }, { env: TEST_ENV, gateOptions: { fetch: sv }, peer: () => peer });
    t.after(() => dev.server.close());
    const v = await raw(dev.port, { method: 'POST', path: VERIFY_PATH, headers: L(dev.port, { accept: HTML, 'content-type': FORM, origin: `http://localhost:${dev.port}` }), body: `token=${DUMMY}&return=%2Fx` });
    assert.equal(v.status, 303, v.body);
    const cookie = v.headers['set-cookie'][0].split(';')[0];
    assert.equal((await raw(dev.port, { path: '/x', headers: L(dev.port, { cookie }) })).status, 200);
    // ...but not through a proxy, not for another Host, not from another address.
    for (const extra of [{ 'x-forwarded-for': '198.51.100.1' }, { via: '1.1 caddy' }, { forwarded: 'for=198.51.100.1' }, { 'x-real-ip': '198.51.100.1' }, { host: 'portal.example.com' }]) {
      const r = await raw(dev.port, { path: '/x', headers: L(dev.port, { cookie, ...extra }) });
      assert.equal(r.status, 503, JSON.stringify(extra));
      assert.equal(r.body, MSG_TEST_KEYS);
    }
    peer = '198.51.100.4';
    assert.equal((await raw(dev.port, { path: '/x', headers: L(dev.port, { cookie }) })).status, 503, 'a non-loopback socket');
  });

  test('localDev: an IP-literal Host (stock nginx proxy_pass) is not local, and NODE_ENV=production ignores it', async (t) => {
    const sv = siteverify({ hostname: 'example.com', action: '' });
    const dev = await serve({ trustCloudflare: false, localDev: true }, { env: TEST_ENV, gateOptions: { fetch: sv }, peer: '127.0.0.1' });
    t.after(() => dev.server.close());
    for (const host of [`127.0.0.1:${dev.port}`, '127.0.0.1:3000', '[::1]:3000', '127.0.0.1']) {
      const v = await raw(dev.port, { method: 'POST', path: VERIFY_PATH, headers: { host, 'user-agent': UA, accept: HTML, 'content-type': FORM }, body: `token=${DUMMY}&return=%2Fx` });
      assert.equal(v.status, 503, host);
      assert.equal(v.body, MSG_TEST_KEYS);
      assert.equal(v.headers['set-cookie'], undefined);
    }
    const real = await serve({ trustCloudflare: false, localDev: true }, { peer: '127.0.0.1' });
    t.after(() => real.server.close());
    const r = await raw(real.port, { headers: { host: '127.0.0.1:3000', 'user-agent': UA, accept: HTML } });
    assert.equal(r.status, 503);
    assert.equal(r.body, MSG_PRIVATE_CLIENT);

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; });
    const prod = await serve({ trustCloudflare: false, localDev: true }, { env: TEST_ENV, gateOptions: { fetch: sv }, peer: '127.0.0.1' });
    t.after(() => prod.server.close());
    const p = await raw(prod.port, { path: '/x', headers: { host: `localhost:${prod.port}`, 'user-agent': UA, accept: HTML } });
    assert.equal(p.status, 503);
    assert.equal(p.body, MSG_TEST_KEYS);
    assert.equal(sv.calls.length, 0);
  });

  test('MSG_PRIVATE_CLIENT says to overwrite CF-Connecting-IP, not only to trust it', () => {
    assert.match(MSG_PRIVATE_CLIENT, /OVERWRITE CF-Connecting-IP/);
    assert.match(MSG_PRIVATE_CLIENT, /GATE_TRUST_CLOUDFLARE/);
    assert.match(MSG_PRIVATE_CLIENT, /INTEGRATION\.md 4\(c\)/);
  });

  test('req.gateExemption is set only for a request the exempt hook let through', async (t) => {
    const marks = [];
    const { server, port } = await serve({}, {
      gateOptions: { exempt: (_r, url) => (url.pathname === '/client/heartbeat' ? 'kidmonitor' : null) },
      app: (req, res) => { marks.push([req.url, req.gateExemption || null]); res.end('ok'); },
    });
    t.after(() => server.close());
    assert.equal((await raw(port, { path: '/client/heartbeat', headers: H })).status, 200);
    const cookie = await passOn(port);
    assert.equal((await raw(port, { path: '/admin', headers: { ...H, cookie } })).status, 200);
    assert.deepEqual(marks, [['/client/heartbeat', 'kidmonitor'], ['/admin', null]]);
  });

  test('real keys on localhost: a loopback client address is accepted only with localDev', async (t) => {
    const off = await serve({ trustCloudflare: false });
    const on = await serve({ trustCloudflare: false, localDev: true });
    t.after(() => { off.server.close(); on.server.close(); });
    const L = (port) => ({ host: `localhost:${port}`, 'user-agent': UA, accept: HTML });
    const a = await raw(off.port, { headers: L(off.port) });
    assert.equal(a.status, 503);
    assert.equal(a.body, MSG_PRIVATE_CLIENT);
    assert.equal((await raw(on.port, { headers: L(on.port) })).status, 403, 'the challenge');
  });

  test('GATE_MODE="off" lets everything through whatever the address; missing keys keep their own 503', async (t) => {
    const off = await serve({ trustCloudflare: false }, { env: { ...ENV, GATE_MODE: 'off' } });
    const none = await serve({ trustCloudflare: false }, { env: {} });
    t.after(() => { off.server.close(); none.server.close(); });
    assert.equal((await raw(off.port, { headers: H })).status, 200);
    const r = await raw(none.port, { headers: H });
    assert.equal(r.status, 503);
    assert.equal(r.body, MSG_NOT_CONFIGURED);
  });

  test('raw paths the app would route differently from the gate are a 400, before any hook runs', async (t) => {
    const hooked = [];
    const { server, port, seen } = await serve({}, {
      gateOptions: { exempt: (_r, url) => { hooked.push(url.pathname); return url.pathname.startsWith('/client/') ? 'fleet' : null; } },
    });
    t.after(() => server.close());
    const bad = [
      '/admin/../client/x', '/admin/%2e%2e/client/x', '/admin/%2E%2e/client/x', '/admin/.%2e/client/x', '/admin/%2e./client/x',
      '/nothing/../client/x', '/admin/./x', '/admin/..', '/..', '/admin\\..\\client\\x', '/admin/x\\',
      'http://other/admin/../client/x', 'https://portal.example.com/admin/%2e%2e/client/x',
    ];
    for (const p of bad) {
      const r = await raw(port, { path: p, headers: H });
      assert.equal(r.status, 400, p);
      assert.equal(r.body, 'Bad Request');
    }
    assert.deepEqual(hooked, [], 'the exempt hook never saw a normalised path');
    assert.equal(seen.length, 0, 'the app never ran');

    // Gate and app agree on these, so they get the usual answers.
    assert.equal((await raw(port, { path: '/client/x', headers: H })).status, 200);
    assert.equal((await raw(port, { path: '/client/x?next=../admin', headers: H })).status, 200, 'the query is not a path');
    assert.equal((await raw(port, { path: '/admin/x', headers: H })).status, 403);
    assert.equal((await raw(port, { path: '/admin/..%2f../client/x', headers: H })).status, 403, '%2f is not a separator to either side');
    assert.equal((await raw(port, { path: '/a/...b/.c/d.', headers: H })).status, 403, 'dots inside names are fine');
    assert.equal((await raw(port, { path: 'http://other/client/x', headers: H })).status, 200, 'absolute-form keeps its path');
    // Node's own parser already refuses raw non-ASCII and tabs; the adapter does too, for
    // servers run with insecureHTTPParser (WHATWG URL drops a tab, Express would not).
    for (const url of ['/a/%2E%2E/b', '/café', '/cli\tent/x', '/a b']) {
      assert.throws(() => toWebRequest({ method: 'GET', url, headers: { host: HOST }, socket: { remoteAddress: '198.51.100.1' } }), TypeError, JSON.stringify(url));
    }
  });

  test('a "//host" request target stays on this host; a bad Host header is a 400', async (t) => {
    const { server, port } = await serve();
    t.after(() => server.close());
    const r = await raw(port, { path: '//evil.com/x', headers: { ...H, accept: HTML } });
    assert.equal(r.status, 403);
    assert.match(r.body, /name="return" value="\/"/);
    assert.match(r.body, /portal\.example\.com/);
    const bad = await raw(port, { headers: { host: 'a b/c', 'user-agent': UA } });
    assert.equal(bad.status, 400);
    const fakeReq = { method: 'GET', url: 'http://evil.com/abs?x=1', headers: { host: 'portal.example.com' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(toWebRequest(fakeReq).url, 'http://portal.example.com/abs?x=1');
  });

  test('an oversized verify body is refused', async (t) => {
    const { server, port, sv } = await serve();
    t.after(() => server.close());
    const r = await raw(port, {
      method: 'POST', path: VERIFY_PATH,
      headers: { ...H, accept: HTML, 'content-type': FORM },
      body: 'token=abc&pad=' + 'x'.repeat(100000),
    });
    assert.equal(r.status, 403);
    assert.equal(sv.calls.length, 0);
  });

  test('on a pass, writeHead with a header array and CDN-only cache headers still go out private', async (t) => {
    const { server, port } = await serve({}, {
      app: (req, res) => {
        if (req.url === '/arr.js') {
          res.setHeader('Cache-Control', 'no-store');
          res.writeHead(200, [
            'Cache-Control', 'public, max-age=86400', 'Content-Type', 'text/javascript',
            'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'CDN-Cache-Control', 'max-age=86400',
          ]);
          res.end('js()');
        } else if (req.url === '/msg') {
          res.writeHead(200, 'Fine', { 'Cache-Control': 'public, s-maxage=600', 'Surrogate-Control': 'max-age=600', Vary: 'Accept' });
          res.end('m');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=60');
          res.setHeader('CDN-Cache-Control', 'max-age=86400');
          res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
          res.setHeader('X-Accel-Expires', '600');
          res.end('x');
        }
      },
    });
    t.after(() => server.close());
    const cookie = await passOn(port);
    const arr = await raw(port, { path: '/arr.js', headers: { ...H, cookie } });
    assert.equal(arr.status, 200);
    assert.equal(arr.headers['cache-control'], 'private, max-age=86400', 'the array replaced the earlier no-store, as in Node');
    assert.equal(arr.headers.vary, 'Cookie');
    assert.equal(arr.headers['content-type'], 'text/javascript');
    assert.deepEqual(arr.headers['set-cookie'], ['a=1', 'b=2']);
    assert.equal(arr.headers['cdn-cache-control'], undefined);
    assert.equal(arr.body, 'js()');
    const msg = await raw(port, { path: '/msg', headers: { ...H, cookie } });
    assert.equal(msg.message, 'Fine');
    assert.equal(msg.headers['cache-control'], 'private');
    assert.equal(msg.headers.vary, 'Accept, Cookie');
    assert.equal(msg.headers['surrogate-control'], undefined);
    const set = await raw(port, { path: '/set', headers: { ...H, cookie } });
    assert.equal(set.headers['cache-control'], 'private, max-age=60');
    for (const h of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'x-accel-expires']) assert.equal(set.headers[h], undefined, h);
  });

  test('privatizeNodeResponse leaves an odd-length header array to Node, which refuses it', () => {
    const res = new http.ServerResponse(new http.IncomingMessage(new net.Socket()));
    privatizeNodeResponse(res);
    assert.throws(() => res.writeHead(200, ['Cache-Control']), { code: 'ERR_INVALID_ARG_VALUE' });
  });

  test('writeWebResponse settles when the client is already gone', async (t) => {
    let outcome = null;
    const server = http.createServer(async (req, res) => {
      req.socket.destroy();
      outcome = await Promise.race([
        writeWebResponse(res, new Response('x'.repeat(100))).then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('still pending'), 1500)),
      ]);
    });
    const port = await listen(server);
    t.after(() => server.close());
    await raw(port).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(outcome, 'settled');
  });

  test('a large answer to a client that stops reading and hangs up settles, and stops reading the body', async (t) => {
    let pulled = 0;
    let outcome = null;
    const server = http.createServer(async (req, res) => {
      const chunk = new Uint8Array(64 * 1024);
      const body = new ReadableStream({
        pull(c) { pulled++; if (pulled > 512) c.close(); else c.enqueue(chunk); }, // up to 32 MiB
      });
      outcome = await Promise.race([
        writeWebResponse(res, new Response(body)).then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('still pending'), 3000)),
      ]);
    });
    const port = await listen(server);
    t.after(() => server.close());
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.write('GET / HTTP/1.1\r\nHost: portal.example.com\r\n\r\n');
    sock.pause();
    await new Promise((r) => setTimeout(r, 300));
    sock.destroy();
    for (let i = 0; i < 40 && outcome === null; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(outcome, 'settled');
    assert.ok(pulled < 512, `stopped after ${pulled} chunks`);
  });

  test('the middleware always settles when the client hangs up first (slow siteverify, slow exempt hook)', async (t) => {
    const gate = createGate({
      siteName: 'X',
      fetch: () => new Promise((r) => setTimeout(() => r(Response.json({ success: false, 'error-codes': ['invalid-input-response'] })), 150)),
      exempt: () => new Promise((r) => setTimeout(() => r(null), 150)),
    });
    const mw = createNodeGate(gate, { env: ENV, trustCloudflare: ['127.0.0.1'] });
    let started = 0, settled = 0;
    const server = http.createServer((req, res) => {
      started++;
      mw(req, res).then(() => { settled++; }, () => { settled++; });
    });
    const port = await listen(server);
    t.after(() => server.close());
    for (let i = 0; i < 20; i++) {
      const verify = i % 2 === 0;
      const r = http.request({
        host: '127.0.0.1', port, agent: false, method: verify ? 'POST' : 'GET', path: verify ? VERIFY_PATH : '/',
        headers: { ...H, accept: HTML, ...(verify ? { 'content-type': FORM } : {}) },
      });
      r.on('error', () => {});
      r.end(verify ? verifyBody() : undefined);
      setTimeout(() => r.destroy(), 30);
    }
    for (let i = 0; i < 40 && (started < 20 || settled < started); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(started, 20);
    assert.equal(settled, 20, 'every gate promise settled');
  });

  test('also works as plain middleware with next()', async (t) => {
    const gate = createGate({ siteName: 'X', fetch: siteverify() });
    const mw = createNodeGate(gate, { env: {} });
    const server = http.createServer((req, res) => mw(req, res, () => res.end('never')));
    const port = await listen(server);
    t.after(() => server.close());
    const r = await raw(port, { headers: H });
    assert.equal(r.status, 503);
    assert.equal(r.body, MSG_NOT_CONFIGURED);
  });

  test('the demo server runs the real gate (sanity)', async (t) => {
    const { startDemo, DUMMY_TOKEN } = await import('../demo/serve.mjs');
    process.env.QUIET = '1';
    const d = await startDemo({ port: 0, offline: true });
    t.after(() => d.server.close());
    const base = `http://localhost:${d.port}`;
    const page = await realFetch(base + '/', { headers: { accept: HTML } });
    assert.equal(page.status, 403);
    const v = await realFetch(base + VERIFY_PATH, {
      method: 'POST', redirect: 'manual',
      headers: { accept: HTML, 'content-type': FORM },
      body: `token=${DUMMY_TOKEN}&return=%2Fok`,
    });
    assert.equal(v.status, 303);
    const cookie = v.headers.get('set-cookie').split(';')[0];
    const ok = await realFetch(base + '/ok', { headers: { cookie } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /You're through/);
  });
});
