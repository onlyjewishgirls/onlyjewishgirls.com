import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, h, makeUser, resetHarness, settle, signInAs } from "./harness";

const { recordAndSend, composeAlert, ALERT_DEDUPE_MS } = await import("@/server/alerts");
const { autoBlock } = await import("@/server/threat");
const { resolveSettings } = await import("@/lib/settings-schema");
const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: decoy } = await import("@/app/api/decoy/route");

interface Sent {
  url: string;
  body: Record<string, unknown>;
}
let sent: Sent[] = [];

beforeEach(() => {
  resetHarness();
  h.env.EMAIL_API_KEY = "re_test";
  h.env.EMAIL_FROM = "OnlyJewishGirls <no-reply@onlyjewishgirls.com>";
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const base = { event: "failed_signin" as const, title: "Wrong password", key: "u1:203.0.113.10", what: "Wrong password — account miriam." };

describe("security alert emails (§6)", () => {
  it("goes from securityalerts@ to soc@ the apex by default, through the existing transport", async () => {
    await recordAndSend(base, "www.onlyjewishgirls.com");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect(sent[0].body).toMatchObject({
      from: "OnlyJewishGirls Security <securityalerts@onlyjewishgirls.com>",
      to: ["soc@onlyjewishgirls.com"],
      subject: "[SECURITY] OnlyJewishGirls — Wrong password",
    });
    const row = h.d1.one<{ status: string; to_addr: string; provider: string }>("SELECT * FROM security_alerts")!;
    expect(row).toMatchObject({ status: "sent", to_addr: "soc@onlyjewishgirls.com", provider: "Resend" });
  });

  it("uses ALERTS_EMAIL_FROM / ALERTS_EMAIL_TO when set", async () => {
    h.env.ALERTS_EMAIL_FROM = "alerts@onlyjewishgirls.com";
    h.env.ALERTS_EMAIL_TO = "owner@example.com";
    h.env.ALERT_EMAIL_TO = "legacy@example.com";
    await recordAndSend(base, "onlyjewishgirls.com");
    expect(sent[0].body).toMatchObject({ from: "OnlyJewishGirls Security <alerts@onlyjewishgirls.com>", to: ["owner@example.com"] });
  });

  it("sends one per (event, key) per 10 minutes and counts the rest as +N more", async () => {
    const t0 = Date.now();
    await recordAndSend({ ...base, now: t0 }, "onlyjewishgirls.com");
    await recordAndSend({ ...base, now: t0 + 60_000 }, "onlyjewishgirls.com");
    await recordAndSend({ ...base, now: t0 + 120_000 }, "onlyjewishgirls.com");
    // A different key is its own stream.
    await recordAndSend({ ...base, key: "u2:203.0.113.10", now: t0 + 130_000 }, "onlyjewishgirls.com");
    expect(sent).toHaveLength(2);
    const statuses = h.d1.rows<{ status: string }>("SELECT status FROM security_alerts ORDER BY id").map((r) => r.status);
    expect(statuses).toEqual(["sent", "throttled", "throttled", "sent"]);
    await recordAndSend({ ...base, now: t0 + ALERT_DEDUPE_MS + 1 }, "onlyjewishgirls.com");
    expect(sent).toHaveLength(3);
    expect(String(sent[2].body.text)).toContain("+2 more alerts like this in the last 10 minutes (throttled)");
    expect(h.d1.one<{ suppressed: number }>("SELECT suppressed FROM security_alerts ORDER BY id DESC")!.suppressed).toBe(2);
  });

  it("records a failed delivery", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await recordAndSend(base, "onlyjewishgirls.com");
    expect(h.d1.one<{ status: string; error: string }>("SELECT * FROM security_alerts")).toMatchObject({
      status: "failed",
      error: "Resend answered 500: nope",
    });
  });

  it("carries what/who/IP/country/UA/device/time and a link to the audit entry", () => {
    const mail = composeAlert(
      { ...base, user: { id: 1, username: "miriam" }, ip: "203.0.113.10", country: "US", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", auditId: 42 },
      { site: "OnlyJewishGirls", timeZone: "America/New_York", auditUrl: "https://onlyjewishgirls.com/admin#audit/42", suppressed: 0, now: Date.UTC(2026, 10, 4, 20, 0) },
    );
    for (const s of ["What: Wrong password", "Account: miriam", "IP: 203.0.113.10", "Country: US", "User agent: Mozilla", "Device: ", "(America/New_York)", "2026-11-04T20:00:00.000Z UTC", "Audit entry: https://onlyjewishgirls.com/admin#audit/42"]) {
      expect(mail.text).toContain(s);
    }
    expect(mail.html).toContain('<a href="https://onlyjewishgirls.com/admin#audit/42">');
  });

  it("failed sign-ins email via the audit log (deduped per account + IP)", async () => {
    await makeUser({ username: "miriam" });
    for (let i = 0; i < 3; i++) await call(login, "/api/auth/login", { body: { identifier: "miriam", password: "bad" } });
    await settle();
    const rows = h.d1.rows<{ event: string; status: string }>("SELECT event, status FROM security_alerts WHERE event = 'failed_signin'");
    expect(rows.map((r) => r.status)).toEqual(["sent", "throttled", "throttled"]);
  });

  it("a decoy hit blocks the address and alerts twice (decoy + auto-blacklist)", async () => {
    const r = await call(decoy, "/api/decoy?p=.env");
    expect(r.status).toBe(404);
    await settle();
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("decoy");
    const events = h.d1.rows<{ event: string }>("SELECT event FROM security_alerts ORDER BY id").map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["decoy_hit", "auto_blacklist", "hostile_visitor"]));
  });
});

describe("owner lockout safety (§7)", () => {
  it("still blocks the owner's IP, but the alert says so prominently", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    await signInAs(owner.id);
    await autoBlock("203.0.113.10", "failed_logins", "5 wrong passwords in 15 min.", ["5 wrong passwords"], resolveSettings({}));
    await settle();
    const deny = h.d1.one<{ owner_session: number; sessions_killed: number }>("SELECT * FROM ip_rules WHERE kind = 'deny'")!;
    expect(deny).toMatchObject({ owner_session: 1, sessions_killed: 1 });
    const alert = sent.find((s) => String(s.body.subject).includes("OWNER LOCKOUT"))!;
    expect(alert.body.subject).toBe("[SECURITY] OnlyJewishGirls — OWNER LOCKOUT: Auto-blacklisted the owner's IP");
    expect(String(alert.body.text)).toContain("WARNING: This IP address belongs to the OWNER's live session.");
    expect(String(alert.body.text)).toContain("npx wrangler d1 execute onlyjewishgirls --remote");
    expect(h.d1.one<{ owner_lockout: number }>("SELECT owner_lockout FROM security_alerts WHERE event = 'auto_blacklist'")!.owner_lockout).toBe(1);
  });
});
