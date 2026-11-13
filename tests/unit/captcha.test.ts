/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are read loosely in these tests */
/**
 * The CAPTCHA wall (PORTAL-STANDARD §10) as worker.ts runs it: the Gate kit with this site's hooks
 * (src/worker/captcha.ts) in front of a stand-in for the OpenNext worker that dispatches to the real
 * route handlers (decoy rewrite, sign-in, visitor log, console), against the in-memory D1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, makeUser, resetHarness, settle, signInAs } from "./harness";
import { MSG_NOT_CONFIGURED, MSG_TEST_KEYS, PASS_COOKIE, SITEVERIFY_URL, VERIFY_PATH } from "../../gate-kit/gate.mjs";

const { NextRequest } = await import("next/server");
const { createCaptcha, gateOffAlert, handleRequest, SITE_NAME } = await import("@/worker/captcha");
const decoy = await import("@/app/api/decoy/route");
const login = await import("@/app/api/auth/login/route");
const visit = await import("@/app/api/visit/route");
const consoleRoute = await import("@/app/api/console/[...path]/route");
const { isDecoyPath } = await import("@/lib/security");

const HOST = "onlyjewishgirls.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
// Real-looking (not Cloudflare's always-pass test) keys: the wall must behave as in production.
const KEYS = { TURNSTILE_SITE_KEY: "0x4AAAAAAAunittestsitekey", TURNSTILE_SECRET_KEY: "0x4AAAAAAAunittestsecretkey00000000" };

/** Every call the stand-in app received: if the wall works, unpassed traffic never shows up here. */
let appCalls: string[] = [];
/** Emails handed to Plunk/Resend (the alert sender, mocked). */
let mail: { url: string; body: Record<string, any> }[] = [];
let siteverify: { form: URLSearchParams; answer: Record<string, unknown> }[] = [];
let siteverifyAnswer: Record<string, unknown>;
let captcha: ReturnType<typeof createCaptcha>;

const env = () => h.env as unknown as CloudflareEnv;
const ctx = { waitUntil: (p: Promise<unknown>) => void h.background.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/**
 * Stand-in for `.open-next/worker.js`: next.config.ts's decoy rewrite, then the real handlers for the
 * routes these tests use, else a plain page with CDN caching headers (to see decorate() at work).
 */
const app = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    appCalls.push(`${request.method} ${url.pathname}${url.search}`);
    h.headers = new Headers(request.headers);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const next = (href: string) => new NextRequest(href, { method: request.method, headers: request.headers, body });
    if (isDecoyPath(url.pathname)) return decoy.GET(next(`${url.origin}/api/decoy?p=${encodeURIComponent(url.pathname.slice(1))}`));
    if (url.pathname === "/api/auth/login" && request.method === "POST") return login.POST(next(url.href));
    if (url.pathname === "/api/visit" && request.method === "POST") return visit.POST(next(url.href));
    if (url.pathname.startsWith("/api/console/")) {
      const path = url.pathname.slice("/api/console/".length).split("/");
      const handler = (consoleRoute as Record<string, any>)[request.method];
      return handler(next(url.href), { params: Promise.resolve({ path }) });
    }
    return new Response(`app: ${url.pathname}`, {
      status: url.pathname === "/no-such-page" ? 404 : 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=60, s-maxage=600", "CDN-Cache-Control": "max-age=600" },
    });
  },
};

interface Opts {
  method?: string;
  accept?: string;
  dest?: string;
  cookie?: string;
  ip?: string;
  host?: string;
  body?: string;
  headers?: Record<string, string>;
}

function request(path: string, o: Opts = {}) {
  const host = o.host ?? HOST;
  const headers = new Headers({
    host,
    "cf-connecting-ip": o.ip ?? h.ip,
    "user-agent": UA,
    accept: o.accept ?? "*/*",
    ...(o.dest ? { "sec-fetch-dest": o.dest } : {}),
    ...(o.cookie ? { cookie: o.cookie } : {}),
    ...o.headers,
  });
  const scheme = /^localhost(:|$)/.test(host) ? "http" : "https";
  return new Request(`${scheme}://${host}${path}`, { method: o.method ?? "GET", headers, body: o.body });
}

async function send(path: string, o: Opts = {}) {
  return handleRequest(captcha, app, request(path, o), env(), ctx);
}

const page = (path: string, o: Opts = {}) => send(path, { accept: "text/html,application/xhtml+xml,*/*;q=0.8", dest: "document", ...o });

/** Solves the CAPTCHA (siteverify stubbed) and returns the pass cookie ("__Host-gate_pass=..."). */
async function pass(o: Opts = {}) {
  const res = await send(VERIFY_PATH, {
    method: "POST",
    accept: "text/html",
    dest: "document",
    body: "token=0.unit-test-turnstile-token&return=%2Fhome",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${o.host ?? HOST}` },
    ...o,
  });
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0];
}

const count = (table: string) => h.d1.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

beforeEach(() => {
  resetHarness();
  Object.assign(h.env, KEYS, { EMAIL_API_KEY: "re_test" });
  appCalls = [];
  mail = [];
  siteverify = [];
  siteverifyAnswer = { success: true, hostname: HOST, action: "gate" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    mail.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  });
  captcha = createCaptcha({
    fetch: async (url, init) => {
      expect(url).toBe(SITEVERIFY_URL);
      siteverify.push({ form: new URLSearchParams(String(init.body)), answer: siteverifyAnswer });
      return Response.json(siteverifyAnswer);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("CAPTCHA wall: nothing loads without a pass", () => {
  it("a page navigation gets the challenge page (403), with the kit's own headers untouched", async () => {
    const res = await page("/");
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain(`Checking that you're human before loading ${SITE_NAME}.`);
    expect(html).toContain(KEYS.TURNSTILE_SITE_KEY);
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com/);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("vary")).toBeNull();
    expect(appCalls).toEqual([]);
  });

  it("every other request class gets the 403 JSON and never reaches the app", async () => {
    const cases: [string, Opts][] = [
      ["/_next/static/chunks/main-app.js", { dest: "script" }], // a static asset
      ["/favicon.ico", { accept: "image/avif,image/webp,*/*", dest: "image" }],
      ["/robots.txt", { accept: "text/plain" }],
      ["/api/auth/login", { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: `https://${HOST}` } }],
      ["/api/console/bootstrap", { accept: "application/json", headers: { "x-requested-with": "console" } }],
      ["/no-such-page", { accept: "application/json" }], // a 404 path, fetched
      ["/home", { method: "OPTIONS" }],
      ["/api/webhooks/anything", { method: "POST", body: "{}" }],
    ];
    for (const [path, o] of cases) {
      const res = await send(path, o);
      expect(res.status, `${o.method ?? "GET"} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ ok: false, code: "captcha_required", error: `Complete the CAPTCHA at https://${HOST}/ first.` });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    // Navigations to the console, sign-in and a 404 path get the challenge page.
    for (const path of ["/admin", "/login", "/no-such-page"]) {
      const res = await page(path);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Checking that you're human");
    }
    expect((await page("/", { method: "HEAD" })).status).toBe(403);
    expect(appCalls).toEqual([]);
  });

  it("no machine client is exempt: nothing passes without a CAPTCHA", async () => {
    for (const [method, path] of [["GET", "/manifest.json"], ["POST", "/client/heartbeat"], ["GET", "/api/health"], ["POST", "/api/visit"]]) {
      const req = request(path, { method, body: method === "POST" ? "{}" : undefined });
      const res = await handleRequest(captcha, app, req, env(), ctx);
      expect(res.status).toBe(403);
      expect(captcha.exemptionOf(req)).toBeNull();
    }
    expect(appCalls).toEqual([]);
  });

  it("verify answers 303 with the pass cookie, sending the visitor's IP to siteverify", async () => {
    const res = await send(VERIFY_PATH, {
      method: "POST",
      accept: "text/html",
      dest: "document",
      body: "token=0.unit-test-turnstile-token&return=%2Fhome",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST}` },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/home");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${PASS_COOKIE}=v1\\.`));
    expect(cookie).toContain("Max-Age=43200"); // captcha_pass_hours default: 12
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(attr);
    expect(siteverify[0].form.get("remoteip")).toBe(h.ip);
    expect(siteverify[0].form.get("secret")).toBe(KEYS.TURNSTILE_SECRET_KEY);
    expect(appCalls).toEqual([]);
  });

  it("verify refuses another host's token, a wrong action and a failed check", async () => {
    siteverifyAnswer = { success: true, hostname: "evil.example", action: "gate" };
    expect((await send(VERIFY_PATH, { method: "POST", body: "token=0.abc", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    siteverifyAnswer = { success: true, hostname: HOST, action: "login" };
    expect((await send(VERIFY_PATH, { method: "POST", body: "token=0.abc", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    siteverifyAnswer = { success: false, "error-codes": ["invalid-input-response"] };
    expect((await send(VERIFY_PATH, { method: "POST", body: "token=0.abc", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
  });

  it("with a pass, the same requests are served, with Vary: Cookie and private caching", async () => {
    const cookie = await pass();
    for (const [path, o] of [
      ["/", { accept: "text/html", dest: "document" }],
      ["/_next/static/chunks/main-app.js", { dest: "script" }],
      ["/favicon.ico", { dest: "image" }],
      ["/robots.txt", {}],
    ] as [string, Opts][]) {
      const res = await send(path, { ...o, cookie });
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(`app: ${path}`);
      expect(res.headers.get("vary")).toBe("Cookie");
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
      expect(res.headers.get("cdn-cache-control")).toBeNull();
    }
    expect((await send("/no-such-page", { cookie })).status).toBe(404);
    // The console API answers (here: not signed in) instead of the wall.
    const consoleRes = await send("/api/console/bootstrap", { cookie, accept: "application/json", headers: { "x-requested-with": "console" } });
    expect(consoleRes.status).toBe(401);
    expect(((await consoleRes.json()) as { code: string }).code).toBe("unauthenticated");
    expect(appCalls).toHaveLength(6);
  });

  it("a pass is bound to the IP address and the browser", async () => {
    const cookie = await pass();
    expect((await send("/", { cookie, ip: "198.51.100.7" })).status).toBe(403);
    expect((await send("/", { cookie, headers: { "user-agent": "curl/8.5.0" } })).status).toBe(403);
    expect((await send("/", { cookie, host: "www.onlyjewishgirls.com" })).status).toBe(403);
    expect((await send("/", { cookie })).status).toBe(200);
  });

  it("the pass lifetime comes from the captcha_pass_hours setting", async () => {
    h.d1.exec("INSERT INTO settings (key, value, updated_at) VALUES ('captcha_pass_hours', '3', 0)");
    const res = await send(VERIFY_PATH, { method: "POST", body: "token=0.abc", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=10800");
  });
});

describe("CAPTCHA wall: unpassed traffic is silent (counters only)", () => {
  const scanners: [string, Opts][] = [
    ["/.env", {}],
    ["/wp-login.php", { accept: "text/html", dest: "document" }],
    ["/.git/config", {}],
    ["/?id=1%27%20OR%20%271%27=%271", { accept: "text/html", dest: "document" }],
    ["/api/auth/login?q=%3Cscript%3Ealert(1)%3C/script%3E", { method: "POST", body: '{"identifier":"admin\' OR 1=1--","password":"x"}', headers: { "content-type": "application/json", origin: `https://${HOST}` } }],
    ["/api/visit", { method: "POST", body: '{"path":"/"}', headers: { "content-type": "application/json", origin: `https://${HOST}` } }],
  ];

  it("scanner paths and injection payloads without a pass: no email, audit, deny-list, strike or visitor row", async () => {
    for (const [path, o] of scanners) expect((await send(path, o)).status, path).toBe(403);
    await settle();
    expect(appCalls).toEqual([]);
    expect(mail).toEqual([]);
    for (const table of ["events", "ip_strikes", "ip_rules", "security_alerts", "visits", "rate_limits"]) expect(count(table), table).toBe(0);
    // Only counters.
    await captcha.flushStats(env());
    const stats = h.d1.rows<{ event: string; count: number }>("SELECT event, count FROM gate_stats ORDER BY event");
    expect(stats).toEqual([
      { event: "blocked", count: 4 },
      { event: "challenge_served", count: 2 },
    ]);
  });

  it("the same requests with a pass reach detection: the decoy hit is audited, blocked and alerted", async () => {
    const cookie = await pass();
    const res = await send("/.env", { cookie });
    expect(res.status).toBe(404);
    await settle();
    expect(h.d1.one<{ type: string }>("SELECT type FROM events WHERE type = 'security.decoy'")).toBeTruthy();
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("decoy");
    expect(h.d1.rows<{ event: string }>("SELECT event FROM security_alerts").map((r) => r.event)).toEqual(
      expect.arrayContaining(["decoy_hit", "auto_blacklist"]),
    );
    expect(mail.length).toBeGreaterThan(0);
  });

  it("an injection payload with a pass is refused and blocks the address", async () => {
    const cookie = await pass();
    const [path, o] = scanners[4];
    const res = await send(path, { ...o, cookie });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("injection");
    await settle();
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("injection");
  });

  it("a page view with a pass is logged; without one it isn't", async () => {
    const [path, o] = scanners[5];
    await send(path, o);
    expect(count("visits")).toBe(0);
    const cookie = await pass();
    expect((await send(path, { ...o, cookie })).status).toBe(204);
    expect(count("visits")).toBe(1);
  });

  it("failed verifies are counted, never emailed or blacklisted", async () => {
    siteverifyAnswer = { success: false, "error-codes": ["invalid-input-response"] };
    for (let i = 0; i < 10; i++) {
      await send(VERIFY_PATH, { method: "POST", body: "token=0.abc", headers: { "content-type": "application/x-www-form-urlencoded" } });
    }
    await settle();
    expect(mail).toEqual([]);
    for (const table of ["events", "ip_strikes", "ip_rules", "security_alerts"]) expect(count(table), table).toBe(0);
    await captcha.flushStats(env());
    expect(h.d1.one<{ count: number }>("SELECT count FROM gate_stats WHERE event = 'verify_failed'")?.count).toBe(10);
  });
});

describe("CAPTCHA wall: configuration", () => {
  it("no keys: every request gets the 503, the app is never reached", async () => {
    delete h.env.TURNSTILE_SITE_KEY;
    delete h.env.TURNSTILE_SECRET_KEY;
    for (const path of ["/", "/admin", "/.env", VERIFY_PATH]) {
      const res = await page(path);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(MSG_NOT_CONFIGURED);
    }
    expect(MSG_NOT_CONFIGURED).toBe("Not available: CAPTCHA is not configured (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY).");
    expect(appCalls).toEqual([]);
  });

  it("Cloudflare's test keys are refused on a real host (503) and work on localhost", async () => {
    Object.assign(h.env, { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" });
    const res = await page("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(MSG_TEST_KEYS);
    const local = await page("/", { host: "localhost:8871", ip: "127.0.0.1" });
    expect(local.status).toBe(403);
    expect(await local.text()).toContain("Checking that you're human");
  });

  it('GATE_MODE="off" lets everything through and sends one alert a day, through the normal alert path', async () => {
    h.env.GATE_MODE = "off";
    for (const path of ["/", "/.env", "/robots.txt"]) expect((await send(path)).status).not.toBe(403);
    expect(appCalls).toEqual(["GET /", "GET /.env", "GET /robots.txt"]);
    await settle();
    const alerts = h.d1.rows<{ event: string; status: string; subject: string }>("SELECT * FROM security_alerts WHERE event = 'captcha_off'");
    expect(alerts).toEqual([expect.objectContaining({ status: "sent", subject: "[SECURITY] OnlyJewishGirls — The CAPTCHA wall is OFF" })]);
    const offMail = mail.filter((m) => String(m.body.subject).includes("CAPTCHA wall is OFF"));
    expect(offMail).toHaveLength(1);
    expect(offMail[0].body).toMatchObject({ from: "OnlyJewishGirls Security <securityalerts@onlyjewishgirls.com>", to: ["soc@onlyjewishgirls.com"] });
    // Another isolate later the same day: no second email.
    captcha = createCaptcha();
    await send("/");
    await settle();
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'captcha_off'")).toHaveLength(1);
    // The next day: one more.
    const detail = { ip: h.ip, host: HOST, path: "/", method: "GET", country: null, ua: UA, hour: "" };
    expect(await gateOffAlert(detail, env(), Date.now() + 86_400_000)).not.toBeNull();
    expect(await gateOffAlert(detail, env(), Date.now() + 86_400_000 + 60_000)).toBeNull();
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'captcha_off'")).toHaveLength(2);
  });
});

describe("CAPTCHA wall: console", () => {
  async function asOwner() {
    const owner = await makeUser({ username: "owner", role: "owner" });
    await signInAs(owner.id);
    return owner;
  }
  const consoleCall = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await send(`/api/console/${path}`, {
      method,
      cookie,
      accept: "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "x-requested-with": "console", "content-type": "application/json", origin: `https://${HOST}` },
    });
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };

  it("posture: green when on, red when GATE_MODE is off; stats from gate_stats", async () => {
    await asOwner();
    const cookie = await pass();
    await page("/", { ip: "198.51.100.9" });
    await send("/robots.txt", { ip: "198.51.100.9" });
    await captcha.flushStats(env());
    let o = (await consoleCall(cookie, "GET", "overview")).data;
    expect(o.posture).toContainEqual(expect.objectContaining({ severity: "ok", title: "CAPTCHA wall is on." }));
    const stat = (key: string) => o.stats.find((s: { key: string }) => s.key === key);
    expect(stat("captcha_challenges")).toMatchObject({ value: 1, sub: "1 in 30 days" });
    expect(stat("captcha_solved")).toMatchObject({ value: 1 });
    expect(stat("captcha_blocked")).toMatchObject({ value: 1 });
    expect(stat("captcha_failed")).toMatchObject({ value: 0 });

    h.env.GATE_MODE = "off";
    o = (await consoleCall(cookie, "GET", "overview")).data;
    expect(o.posture).toContainEqual(expect.objectContaining({ severity: "danger", title: "CAPTCHA wall is OFF." }));
    const b = (await consoleCall(cookie, "GET", "bootstrap")).data;
    expect(b.banner.text).toContain("The CAPTCHA wall is OFF");
  });

  it('settings: a "CAPTCHA wall" group with the pass lifetime (1-168 h, default 12); changes audited and alerted', async () => {
    await asOwner();
    const cookie = await pass();
    const s = (await consoleCall(cookie, "GET", "settings")).data;
    expect(s.groups).toContainEqual(expect.objectContaining({ key: "captcha", label: "CAPTCHA wall" }));
    expect(s.items).toContainEqual(expect.objectContaining({ key: "captcha_pass_hours", group: "captcha", type: "int", value: 12, default: 12, min: 1, max: 168, unit: "hours" }));
    expect((await consoleCall(cookie, "PATCH", "settings", { values: { captcha_pass_hours: 0 } })).data).toMatchObject({ code: "validation", field: "captcha_pass_hours" });
    expect((await consoleCall(cookie, "PATCH", "settings", { values: { captcha_pass_hours: 169 } })).data.code).toBe("validation");
    expect((await consoleCall(cookie, "PATCH", "settings", { values: { captcha_pass_hours: 24 } })).data).toMatchObject({ ok: true, changed: ["captcha_pass_hours"] });
    await settle();
    expect(h.d1.one<{ detail: string }>("SELECT detail FROM events WHERE type = 'admin.settings'")!.detail).toContain("captcha_pass_hours: 12 → 24");
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'settings_changed'")).toHaveLength(1);
    // New passes last 24 hours.
    const res = await send(VERIFY_PATH, { method: "POST", body: "token=0.abc", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=86400");
  });
});
