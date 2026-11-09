import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTRY_PRESETS, countryBlockedMessage, countryRefused, parseCountryRule } from "@/lib/country-rule";
import { call, h, makeUser, resetHarness, settle, signInAs } from "./harness";

const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: visit } = await import("@/app/api/visit/route");
const { POST: logout } = await import("@/app/api/auth/logout/route");
const consoleRoute = await import("@/app/api/console/[...path]/route");

const c = (method: string, path: string, body?: unknown) =>
  call(consoleRoute[method as "GET"] as never, `/api/console/${path}`, {
    method,
    body,
    headers: { "x-requested-with": "console" },
    ctx: { params: Promise.resolve({ path: path.split("/") }) } as never,
  });
const setRule = (mode: string, countries: string[]) =>
  h.d1.exec(
    "INSERT INTO settings (key, value, updated_at) VALUES ('country_rule', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify({ mode, countries }),
  );

describe("country rule logic (§9)", () => {
  it("allow = only listed, deny = listed refused, unknown never, empty list = no rule", () => {
    expect(countryRefused({ mode: "allow", countries: ["US", "CA"] }, "DE")).toBe(true);
    expect(countryRefused({ mode: "allow", countries: ["US", "CA"] }, "CA")).toBe(false);
    expect(countryRefused({ mode: "deny", countries: ["DE"] }, "DE")).toBe(true);
    expect(countryRefused({ mode: "deny", countries: ["DE"] }, "US")).toBe(false);
    for (const unknown of [null, undefined, "", "XX", "T1"]) expect(countryRefused({ mode: "allow", countries: ["US"] }, unknown)).toBe(false);
    expect(countryRefused({ mode: "allow", countries: [] }, "DE")).toBe(false);
    expect(countryRefused({ mode: "off", countries: ["US"] }, "DE")).toBe(false);
  });

  it("states the exact error and validates input", () => {
    expect(countryBlockedMessage("DE")).toBe("Sign-in from Germany (DE) is not allowed on this site.");
    expect(parseCountryRule({ mode: "allow", countries: ["us", "CA", "US"] })).toEqual({ ok: true, rule: { mode: "allow", countries: ["CA", "US"] } });
    expect(parseCountryRule({ mode: "allow", countries: ["ZZ"] })).toMatchObject({ ok: false, field: "countries", error: "Not a country code: ZZ." });
    expect(parseCountryRule({ mode: "maybe", countries: [] })).toMatchObject({ ok: false, field: "mode" });
    expect(COUNTRY_PRESETS.map((p) => p.label)).toEqual(["United States only", "US and Canada", "US, Canada and Israel", "No rule"]);
  });
});

describe("country rule enforcement (§9)", () => {
  beforeEach(() => resetHarness());
  afterEach(() => vi.unstubAllGlobals());

  it("refuses sign-in from a refused country with country_blocked, audits and alerts once per country per 10 min", async () => {
    await makeUser({ username: "rachel" });
    setRule("allow", ["US", "CA"]);
    h.cf = { country: "DE" };
    const r = await call(login, "/api/auth/login", { body: { identifier: "rachel", password: "x" } });
    expect(r.status).toBe(403);
    expect(r.data).toMatchObject({ ok: false, code: "country_blocked", error: "Sign-in from Germany (DE) is not allowed on this site." });
    await call(login, "/api/auth/login", { body: { identifier: "rachel", password: "x" } });
    await settle();
    expect(h.d1.one("SELECT COUNT(*) AS n FROM events WHERE type = 'signin.country_blocked'")!.n).toBe(2);
    expect(h.d1.rows<{ status: string; dedupe_key: string }>("SELECT status, dedupe_key FROM security_alerts WHERE event = 'country_blocked'")).toEqual([
      expect.objectContaining({ dedupe_key: "country:DE" }),
      expect.objectContaining({ status: "throttled" }),
    ]);
    // Not a failed password: no strike, no lockout counting.
    expect(h.d1.rows("SELECT * FROM ip_strikes")).toHaveLength(0);
  });

  it("deny mode, the CF-IPCountry header fallback, and unknown countries", async () => {
    await makeUser({ username: "sarah" });
    setRule("deny", ["RU"]);
    const asCountry = (code: string | null) =>
      call(login, "/api/auth/login", { body: { identifier: "sarah", password: "x" }, headers: code ? { "cf-ipcountry": code } : {} });
    expect((await asCountry("RU")).data.code).toBe("country_blocked");
    expect((await asCountry("US")).data.code).toBe("wrong_password");
    expect((await asCountry("XX")).data.code).toBe("wrong_password");
    expect((await asCountry(null)).data.code).toBe("wrong_password");
  });

  it("never applies to an allowlisted address, public pages, or signing out", async () => {
    await makeUser({ username: "leah" });
    setRule("allow", ["US"]);
    h.cf = { country: "DE" };
    expect((await call(visit, "/api/visit", { body: { path: "/" } })).status).toBeLessThan(300);
    expect((await call(logout, "/api/auth/logout", { body: {} })).status).toBe(200);
    h.d1.exec("INSERT INTO ip_rules (kind, ip, created_at) VALUES ('allow', '203.0.113.10', 1)");
    expect((await call(login, "/api/auth/login", { body: { identifier: "leah", password: "x" } })).data.code).toBe("wrong_password");
  });

  it("guards the console too", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    await signInAs(owner.id);
    setRule("allow", ["US"]);
    h.cf = { country: "FR" };
    expect((await c("GET", "bootstrap")).data).toMatchObject({ code: "country_blocked", error: "Sign-in from France (FR) is not allowed on this site." });
  });
});

describe("console: GET/PUT /country-rule (§9, API.md §11)", () => {
  beforeEach(() => resetHarness());

  it("reads the rule with presets and your country; features on", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    await signInAs(owner.id);
    h.cf = { country: "US" };
    const b = (await c("GET", "bootstrap")).data as { features: Record<string, boolean> };
    expect(b.features).toMatchObject({ country_rule: true, country_deny_mode: true });
    const r = (await c("GET", "country-rule")).data;
    expect(r).toMatchObject({ ok: true, mode: "off", countries: [], modes: ["off", "allow", "deny"], your_country: "US", can_manage: true });
    expect((r.presets as unknown[]).length).toBe(4);
  });

  it("saves, audits and alerts; refuses a rule that would lock you out unless your IP is allowlisted", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    await signInAs(owner.id);
    h.cf = { country: "IL" };
    const lock = await c("PUT", "country-rule", { mode: "allow", countries: ["US"] });
    expect(lock.data).toMatchObject({ code: "self_lockout" });
    expect(lock.data.error).toMatch(/^This rule would refuse your own country, Israel \(IL\)/);
    expect((await c("PUT", "country-rule", { mode: "deny", countries: ["IL"] })).data.code).toBe("self_lockout");

    const ok = await c("PUT", "country-rule", { mode: "allow", countries: ["US", "CA", "IL"] });
    expect(ok.data).toEqual({ ok: true, mode: "allow", countries: ["CA", "IL", "US"] });
    expect(h.d1.one<{ detail: string }>("SELECT detail FROM events WHERE type = 'admin.country_rule'")!.detail).toContain("only CA, IL, US");
    await settle();
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'ip_list_changed'")).toHaveLength(1);

    h.d1.exec("INSERT INTO ip_rules (kind, ip, created_at) VALUES ('allow', '203.0.113.10', 1)");
    expect((await c("PUT", "country-rule", { mode: "allow", countries: ["US"] })).data.ok).toBe(true);
  });

  it("admins can read but not change it", async () => {
    const admin = await makeUser({ username: "adm", role: "admin" });
    await signInAs(admin.id);
    expect((await c("GET", "country-rule")).data.can_manage).toBe(false);
    expect((await c("PUT", "country-rule", { mode: "off", countries: [] })).data).toMatchObject({ code: "forbidden", perm: "ips.manage" });
  });
});
