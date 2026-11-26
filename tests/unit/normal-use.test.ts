/**
 * PORTAL-STANDARD §7, "normal use must never trip the auto-blocker" (owner, 2026-11-26): replays a full,
 * busy, normal session for a member, an admin and the owner, typing hostile-looking but ordinary text
 * everywhere a person can type, and checks that nothing is flagged: no deny-list entry, no auto-block,
 * no strike that could add up to one, and no alert email other than the ones a normal session produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, h, makeUser, resetHarness, settle, signInAs } from "./harness";

const consoleRoute = await import("@/app/api/console/[...path]/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: sendCode } = await import("@/app/api/mfa/email/send/route");
const { POST: verifyCode } = await import("@/app/api/mfa/email/verify/route");
const { POST: passwordCheck } = await import("@/app/api/auth/password-check/route");
const { POST: changePassword } = await import("@/app/api/auth/change-password/route");
const { POST: visit } = await import("@/app/api/visit/route");
const { POST: restore } = await import("@/app/api/streak/restore/route");
const { POST: passkeyOptions } = await import("@/app/api/auth/passkey/options/route");
const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
const { POST: adminAction } = await import("@/app/api/admin/action/route");
const { POST: adminCreate } = await import("@/app/api/admin/create/route");
const { POST: adminExport } = await import("@/app/api/admin/export/route");
const { GET: adminConsolePage } = await import("@/app/admin/route");
const { isDecoyPath, findInjection } = await import("@/lib/security");
const { threatScore } = await import("@/lib/security");

/** Ordinary text that looks like an attack to a naive filter. */
const HOSTILE = [
  "O'Brien",
  "<b>hi</b>",
  "SELECT * FROM users",
  "../notes",
  "https://example.com/?a=1&b=2",
  "🙂🔥",
  "שלום עליכם",
  "it's 'fine' or 1=1 -- really; drop by later",
  "{{name}} ${total}",
  "x".repeat(1500),
].join(" \n");
const SHORT = "O'Brien <b>hi</b> SELECT * FROM ../notes https://example.com/?a=1&b=2 🙂 שלום";

let sent: { to: string; subject: string; body: string }[] = [];

beforeEach(() => {
  resetHarness();
  h.env.PLUNK_API_KEY = "sk_test";
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function consoleCall(method: string, p: string, body?: unknown) {
  const [route] = p.split("?");
  return call(consoleRoute[method as "GET"] as never, `/api/console/${p}`, {
    method,
    body,
    headers: { "x-requested-with": "console" },
    ctx: { params: Promise.resolve({ path: route.split("/") }) } as never,
  });
}

/** Nothing about this session looks suspicious to the auto-blocker. */
function expectNothingFlagged() {
  expect(h.d1.rows("SELECT ip, reason, evidence FROM ip_rules WHERE kind = 'deny' AND source = 'auto'")).toEqual([]);
  expect(h.d1.rows("SELECT type, detail FROM events WHERE type IN ('security.auto_blocked', 'security.auto_block_skipped', 'security.hostile', 'security.decoy', 'security.injection', 'security.admin_denied')")).toEqual([]);
  expect(h.d1.rows("SELECT kind, subject FROM ip_strikes WHERE kind IN ('decoy', 'injection', 'admin_denied', 'rate_limit')")).toEqual([]);
  const anonymous = h.d1.rows("SELECT event FROM security_alerts WHERE event IN ('auto_blacklist', 'decoy_hit', 'hostile_visitor', 'admin_access_denied')");
  expect(anonymous).toEqual([]);
  // What's left of the strikes can't add up to a block, or to the hostile band.
  for (const { ip } of h.d1.rows<{ ip: string }>("SELECT DISTINCT ip FROM ip_strikes")) {
    const counts = h.d1.rows<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM ip_strikes WHERE ip = ? GROUP BY kind", ip);
    const c = Object.fromEntries(counts.map((r) => [r.kind, r.n]));
    expect([ip, threatScore(c).score < 80]).toEqual([ip, true]);
    expect([ip, (c.failed_password ?? 0) < 5 && (c.failed_mfa ?? 0) < 5]).toEqual([ip, true]);
  }
}

/** The alert emails a normal session may produce (§6 "Email"): its own typos and admins' changes. */
const NORMAL_ALERT_SUBJECTS = [
  "Failed sign-in attempt",
  "Failed two-step verification",
  "Sign-in from a new device or location",
  "Administrator signed in",
  "Two-step sign-in settings changed",
  "Account password changed",
  "Account role or permissions changed",
  "New account created",
  "Account status changed",
  "IP allowlist or deny list changed",
  "Streak changed by an administrator",
  "Portal settings changed",
  "Test alert",
];
function expectOnlyNormalEmails() {
  for (const m of sent.filter((s) => s.to === "soc@onlyjewishgirls.com")) {
    const what = m.subject.replace(/^\[OnlyJewishGirls\] /, "").replace(/ on the member site( \(and \d+ more like it\))?$/, "");
    expect([m.subject, NORMAL_ALERT_SUBJECTS.includes(what)]).toEqual([m.subject, true]);
  }
}

describe("a normal member session is never flagged (§7)", () => {
  it("two wrong passwords then the right one, an email code with one typo and a resend, then a busy session", async () => {
    const member = await makeUser({ username: "rivka" });
    h.ip = "198.51.100.10";
    // Two typos, then the right password.
    for (const pw of ["Correct-Horse-Battery-Staple-8!", "correct-horse-battery-staple-9!"]) {
      expect((await call(login, "/api/auth/login", { body: { identifier: "rivka", password: pw } })).data.code).toBe("wrong_password");
    }
    expect((await call(login, "/api/auth/login", { body: { identifier: "rivka", password: member.password } })).data).toMatchObject({ ok: true });
    // An email code: a typo, then the right one.
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.ok).toBe(true);
    // Asking again within a minute is refused politely, and isn't a strike.
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.code).toBe("rate_limited");
    const code = />(\d{6})<\/p>/.exec(sent.filter((m) => m.to === "rivka@example.com").at(-1)!.body)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await call(verifyCode, "/api/mfa/email/verify", { body: { code: wrong } })).data.code).toBe("mfa_wrong_code");
    expect((await call(verifyCode, "/api/mfa/email/verify", { body: { code } })).data).toMatchObject({ next: "/home" });
    await settle();
    // The sign-in shows the typos were the member's own: they no longer count against the address.
    expect(h.d1.rows("SELECT * FROM ip_strikes WHERE ip = ?", h.ip)).toEqual([]);

    // The live password checklist while typing a new password, fast (one request per keystroke, twice over).
    const typed = "Zq9!Xv#Lm2@Pw7$Kr4 O'Brien <b>hi</b> ../notes";
    for (let round = 0; round < 2; round++) {
      for (let i = 1; i <= typed.length; i++) await call(passwordCheck, "/api/auth/password-check", { body: { self: true, password: typed.slice(0, i) } });
    }
    // Hammering the checklist past its limit is one trip at most, never enough to block.
    for (let i = 0; i < 130; i++) await call(passwordCheck, "/api/auth/password-check", { body: { self: true, password: `x${i}` } });
    h.d1.exec("DELETE FROM ip_strikes WHERE kind = 'rate_limit' AND subject = 'password checks'"); // checked separately below
    // Changing the password: the current one mistyped once, then right.
    expect((await call(changePassword, "/api/auth/change-password", { body: { currentPassword: "nope", password: "x", confirmPassword: "x" } })).status).toBe(400);
    const r = await call(changePassword, "/api/auth/change-password", {
      body: { currentPassword: member.password, password: "Zq9!Xv#Lm2@Pw7$Kr4Tb", confirmPassword: "Zq9!Xv#Lm2@Pw7$Kr4Tb" },
    });
    expect(r.status).toBe(200);
    // Page views, including paths with characters a filter might dislike.
    for (const p of ["/", "/home", "/change-password", "/setup-mfa", "/home/O'Brien", "/home/%7B%7Bname%7D%7D", "/home/SELECT%20*%20FROM"]) {
      expect((await call(visit, "/api/visit", { body: { path: p, referrer: "https://example.com/?a=1&b=2", tz: "Asia/Jerusalem", lang: "he-IL", screen: "390x844" } })).status).toBe(204);
    }
    // Streak restore (refused or not, it's a normal request), passkey prompts, a forgot-password request.
    await call(restore, "/api/streak/restore", { body: {} });
    for (let i = 0; i < 5; i++) await call(passkeyOptions, "/api/auth/passkey/options", { body: {} });
    await call(forgot, "/api/auth/forgot-password", { body: { identifier: "rivka" } });
    await settle();

    expectNothingFlagged();
    expectOnlyNormalEmails();
  });

  it("a fast typist on the password checklist trips its limit once: one strike, not one per keystroke", async () => {
    h.ip = "198.51.100.11";
    for (let i = 0; i < 200; i++) await call(passwordCheck, "/api/auth/password-check", { body: { password: `Typing-${i}` } });
    expect(h.d1.rows<{ kind: string }>("SELECT kind FROM ip_strikes WHERE ip = ?", h.ip).map((r) => r.kind)).toEqual(["rate_limit"]);
    expect(h.d1.rows("SELECT * FROM ip_rules WHERE kind = 'deny'")).toEqual([]);
  });

  it("four wrong passwords and four wrong codes (each under its threshold) never reach the hostile band", async () => {
    expect(threatScore({ failed_password: 4, failed_mfa: 4 }).score).toBeLessThan(80);
    expect(threatScore({ failed_password: 4, failed_mfa: 4, rate_limit: 2, accounts: 2 }).score).toBeLessThan(80);
    // Real attack signals still score on top.
    expect(threatScore({ decoy: 1 }).score).toBe(80);
    expect(threatScore({ failed_password: 4, admin_denied: 2 }).score).toBe(80);
  });
});

describe("normal admin and owner sessions are never flagged (§7)", () => {
  for (const role of ["admin", "owner"] as const) {
    it(`${role}: every console section and action, hostile-looking text everywhere, 100 quick polls, every export format`, async () => {
      const me = await makeUser({ username: `the_${role}`, role });
      const member = await makeUser({ username: "member1" });
      const other = await makeUser({ username: "member2" });
      h.ip = role === "admin" ? "198.51.100.20" : "198.51.100.30";
      await signInAs(me.id);

      // The console page itself, and its polling: 100 quick refreshes of what it loads.
      expect((await call(adminConsolePage as never, "/admin")).status).toBe(200);
      for (let i = 0; i < 100; i++) {
        await consoleCall("GET", ["bootstrap", "overview", "events", "alerts", "people"][i % 5]);
      }
      // Every read, with hostile-looking search text and deep-link style query strings.
      const q = encodeURIComponent(SHORT);
      for (const p of [
        "people/schema", `people?q=${q}`, `people?q=${encodeURIComponent("' OR 1=1 --")}&status=active&sort=name`, `people/${member.id}`,
        "roles", "streaks", "streaks/restores", "settings", "security/visitors", `security/visitors?q=${q}`, "ips", "deny", "country-rule",
        "sessions", `audit?q=${q}`, "audit?category=people", `audit?person=${member.id}`, `alerts?q=${q}&status=sent`, "audit/verify",
      ]) {
        const r = await consoleCall("GET", p);
        expect([p, r.status < 500]).toEqual([p, true]);
      }

      // Writes, each carrying ordinary text that looks hostile.
      const ok = async (method: string, p: string, body?: unknown) => {
        const r = await consoleCall(method, p, body);
        if (process.env.REPLAY_DEBUG) console.log(method, p, r.status, r.data.error ?? "");
        return r;
      };
      await ok("PATCH", `people/${member.id}`, { notes: HOSTILE });
      await ok("PATCH", `people/${member.id}`, { first_name: "Seán", last_name: "O'Brien-Cohen", middle_name: "" });
      await ok("PATCH", `people/${member.id}`, { first_name: "../notes", last_name: "<b>hi</b>" }); // refused by validation, not flagged
      await ok("PATCH", `people/${member.id}`, { time_zone: "Asia/Jerusalem" });
      await ok("POST", `people/${member.id}/status`, { status: "suspended", reason: SHORT });
      await ok("POST", `people/${member.id}/status`, { status: "active" });
      await ok("POST", `people/${member.id}/lock`, { minutes: 30, reason: SHORT });
      await ok("POST", `people/${member.id}/unlock`, {});
      await ok("POST", `people/${member.id}/force-change`, { on: true });
      await ok("POST", `people/${member.id}/force-change`, { on: false });
      await ok("POST", `people/${member.id}/mfa/email`, { enabled: false });
      await ok("POST", `people/${member.id}/mfa/email`, { enabled: true });
      await ok("POST", `people/${member.id}/sessions/revoke`, {});
      await ok("POST", `people/${member.id}/streak`, { current: 12 });
      await ok("POST", `people/${member.id}/streak/restores`, { extra: 2 });
      await ok("POST", `people/${member.id}/email`, { subject: SHORT, body: HOSTILE });
      await ok("POST", `people/${member.id}/password`, { mode: "link" });
      await ok("POST", `people/${member.id}/password`, { mode: "temporary" });
      if (role === "owner") {
        await ok("POST", `people/${other.id}/roles`, { role: "admin" });
        await ok("POST", `people/${other.id}/roles`, { role: "member" });
        await ok("POST", `people/${other.id}/permissions`, { permissions: ["streaks.manage"] });
      }
      await ok("POST", "people", { name: "Chana O'Brien", username: "chana_ob", email: "chana.o'brien@example.com", phone: "+12125550188", role: "member" });
      await ok("POST", "ips", { ip_or_cidr: "203.0.113.0/24", label: SHORT.slice(0, 90), note: HOSTILE.slice(0, 290) });
      const allow = h.d1.one<{ id: number }>("SELECT id FROM ip_rules WHERE kind = 'allow' ORDER BY id DESC");
      if (allow) {
        await ok("PATCH", `ips/${allow.id}`, { label: "Office <b>main</b> & ../annex" });
        await ok("DELETE", `ips/${allow.id}`);
      }
      await ok("POST", "deny", { ip_or_cidr: "192.0.2.200", reason: SHORT });
      const deny = h.d1.one<{ id: number }>("SELECT id FROM ip_rules WHERE kind = 'deny' AND ip = '192.0.2.200'");
      if (deny) {
        await ok("PATCH", `deny/${deny.id}`, { reason: HOSTILE.slice(0, 290) });
        await ok("POST", `deny/${deny.id}/unblock`, {});
      }
      await ok("PUT", "country-rule", { mode: "deny", countries: ["KP"] });
      await ok("PUT", "country-rule", { mode: "off", countries: [] });
      await ok("PATCH", "settings", { values: { auto_block_window_minutes: 15 } });
      await ok("POST", "alerts/test", {});
      for (const format of ["txt", "json", "csv", "docx", "pdf", "html"]) {
        for (const section of ["people", "audit", "alerts", "deny", "ips", "streaks"]) {
          await ok("POST", "exports", { section, title: `${section} — ${SHORT}`, format, rows: 17 });
        }
      }
      const undoable = h.d1.one<{ id: number }>("SELECT id FROM events WHERE type = 'admin.set_note' ORDER BY id DESC");
      if (undoable) await ok("POST", `audit/${undoable.id}/revert`, {});

      // The classic admin panel's actions, also with hostile-looking text.
      const classic = (action: string, body: Record<string, unknown>) =>
        call(adminAction, "/api/admin/action", { body: { action, userId: other.id, expectUsername: other.username, ...body } });
      await classic("set_note", { note: HOSTILE });
      await classic("suspend", { reason: SHORT });
      await classic("unsuspend", {});
      await classic("edit_profile", {
        firstName: "../notes", middleName: "", lastName: "O'Brien' or 1=1 --", email: "member2@example.com", username: "member2", phone: "+12125550100",
      });
      await classic("edit_profile", {
        firstName: "Dov", middleName: "", lastName: "O'Brien", email: "dov.o'brien@example.com", username: "member2", phone: "+12125550100",
      });
      await call(adminCreate, "/api/admin/create", {
        body: { firstName: "{{name}}", middleName: "", lastName: "<script>x</script>", email: "new@example.com", username: "SELECT", phone: "+12125550199" },
      });
      await call(adminExport, "/api/admin/export", { body: {} });

      await settle();
      expectNothingFlagged();
      expectOnlyNormalEmails();
    });
  }

  it("an admin demoted while their console is open keeps getting 'not found', without becoming a strike", async () => {
    const owner = await makeUser({ username: "boss", role: "owner" });
    const admin = await makeUser({ username: "helper", role: "admin" });
    h.ip = "198.51.100.40";
    await signInAs(owner.id);
    await consoleCall("POST", `people/${admin.id}/roles`, { role: "member" });
    h.ip = "198.51.100.41";
    await signInAs(admin.id);
    for (let i = 0; i < 10; i++) expect((await consoleCall("GET", ["bootstrap", "people", "overview"][i % 3])).status).toBe(404);
    await settle();
    expect(h.d1.rows("SELECT * FROM ip_rules WHERE kind = 'deny'")).toEqual([]);
    expect(h.d1.rows("SELECT * FROM ip_strikes WHERE kind = 'admin_denied'")).toEqual([]);
    // Still audited.
    expect(h.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'security.admin_denied'")!.n).toBe(10);
  });
});

describe("real attacks are still caught (§7)", () => {
  it("a signed-in session hammering the admin API without permission is still blocked", async () => {
    const member = await makeUser({ username: "nosy" });
    h.ip = "198.51.100.50";
    await signInAs(member.id);
    for (let i = 0; i < 3; i++) await consoleCall("GET", "people");
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("admin_denied");
  });

  it("an injection in the sign-in identifier or an API URL is still blocked", async () => {
    h.ip = "198.51.100.51";
    expect((await call(login, "/api/auth/login", { body: { identifier: "admin' OR 1=1 --", password: "x" } })).data.code).toBe("injection");
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("injection");
    expect(findInjection(["../../etc/passwd"])).not.toBeNull();
  });

  it("scanner paths still count; look-alikes the rewrite catches (/pmail, /.github) don't", () => {
    for (const p of ["/.env", "/.git/config", "/wp-login.php", "/blog/wp-login.php", "/foo/xmlrpc.php", "/phpmyadmin", "/pma/", "/actuator/health"]) {
      expect([p, isDecoyPath(p)]).toEqual([p, true]);
    }
    for (const p of ["/pmail", "/.github", "/administrators-guide", "/admin", "/admin/users", "/home"]) expect([p, isDecoyPath(p)]).toEqual([p, false]);
  });
});

describe("the portal's own pages, links and assets never look like a scanner (§7)", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const full = path.join(dir, f);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  it("no page route, public file or linked path is a decoy path", () => {
    const pages = walk(path.join(root, "src/app"))
      .filter((f) => /\/(page|route)\.tsx?$/.test(f))
      .map((f) => "/" + path.relative(path.join(root, "src/app"), path.dirname(f)).replace(/\[[^\]]+\]/g, "1"));
    const publicFiles = walk(path.join(root, "public")).map((f) => "/" + path.relative(path.join(root, "public"), f));
    const linked = walk(path.join(root, "src"))
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/(?:href|src|action|fetch\(|postJson[^(]*\(|url\()\s*[=(]?\s*["'`](\/[^"'`$?#\s]*)/g)].map((m) => m[1]));
    const all = [...pages, ...publicFiles, ...linked, "/favicon.ico", "/robots.txt", "/manifest.webmanifest", "/sw.js", "/.well-known/webauthn", "/apple-touch-icon.png"];
    expect(linked.length).toBeGreaterThan(20);
    for (const p of all) expect([p, isDecoyPath(p)]).toEqual([p, false]);
  });

  it("every asset the console page references exists", async () => {
    const html = await (await call(adminConsolePage as never, "/admin")).res.text().catch(() => "");
    // Not signed in: a redirect; read the markup from the module instead.
    const src = readFileSync(path.join(root, "src/app/admin/route.ts"), "utf8");
    for (const m of (html + src).matchAll(/(?:href|src)="(\/console\/[^"?]+)/g)) {
      expect([m[1], statSync(path.join(root, "public", m[1])).isFile()]).toEqual([m[1], true]);
    }
  });
});
