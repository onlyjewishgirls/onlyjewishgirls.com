import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, h, makeUser, resetHarness, settle } from "./harness";

const { recordAndSend } = await import("@/server/alerts");
const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
const { POST: sendCode } = await import("@/app/api/mfa/email/send/route");
const { randomToken, sha256 } = await import("@/server/crypto");

let sent: { url: string; body: Record<string, unknown> }[] = [];
function answer(...statuses: number[]) {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  });
}
const PLUNK = "https://next-api.useplunk.com/v1/send";

beforeEach(() => {
  resetHarness();
  h.env.PLUNK_API_KEY = "sk_test"; // and nothing else: no EMAIL_FROM
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PLUNK_API_KEY alone is a complete mail set-up (§8)", () => {
  it("delivers a security alert through Plunk from ALERTS_EMAIL_FROM's default, and records the provider", async () => {
    answer(200);
    await recordAndSend({ event: "test", title: "Test alert", key: "k", what: "A test." }, "onlyjewishgirls.com");
    expect(sent).toEqual([
      {
        url: PLUNK,
        body: expect.objectContaining({
          to: "soc@onlyjewishgirls.com",
          from: { name: "OnlyJewishGirls", email: "securityalerts@onlyjewishgirls.com" },
          reply: "info@onlyjewishgirls.com",
          subject: "[OnlyJewishGirls] Test alert on the member site",
        }),
      },
    ]);
    expect(h.d1.one<{ status: string; provider: string }>("SELECT status, provider FROM security_alerts")).toMatchObject({ status: "sent", provider: "plunk" });
  });

  it("delivers a password-reset email from the default account sender", async () => {
    await makeUser({ username: "ruthie" });
    answer(200);
    const r = await call(forgot, "/api/auth/forgot-password", { body: { identifier: "ruthie" } });
    expect(r.data.ok).toBe(true);
    await settle();
    const reset = sent.find((s) => String(s.body.subject) === "[OnlyJewishGirls] Password reset requested on the member site")!;
    expect(reset).toMatchObject({ url: PLUNK, body: { to: "ruthie@example.com", from: { name: "OnlyJewishGirls", email: "no-reply@onlyjewishgirls.com" }, reply: "info@onlyjewishgirls.com" } });
    expect(String(reset.body.body)).toContain("/reset-password?token=");
  });

  it("delivers an email sign-in code", async () => {
    const u = await makeUser({ username: "codey" });
    const token = randomToken();
    h.d1.exec(
      "INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at, ip) VALUES (?, ?, 'password', ?, ?, ?, ?)",
      sha256(token), u.id, Date.now(), Date.now(), Date.now() + 600_000, h.ip,
    );
    h.cookies.set("__Host-ojg_session", token);
    answer(200);
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.ok).toBe(true);
    expect(sent[0]).toMatchObject({ url: PLUNK, body: { to: "codey@example.com", subject: "[OnlyJewishGirls] Sign-in code requested on the member site" } });
  });

  it("a RESEND_API_KEY that is still set is never used: alerts and reset links go to Plunk only", async () => {
    h.env.RESEND_API_KEY = "re_test";
    h.env.EMAIL_API_KEY = "re_test"; // this site's old name for the Resend key
    h.env.EMAIL_PRIMARY = "resend";
    await makeUser({ username: "resa" });
    answer(200, 200, 200);
    await recordAndSend({ event: "test", title: "Test alert", key: "k3", what: "A test." }, "onlyjewishgirls.com");
    await call(forgot, "/api/auth/forgot-password", { body: { identifier: "resa" } });
    await settle();
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((s) => s.url === PLUNK)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("resend.com");
  });

  it("a Plunk 5xx is retried once and then recorded as failed (provider plunk); no other provider is tried", async () => {
    h.env.RESEND_API_KEY = "re_test";
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(502, 503);
    await recordAndSend({ event: "test", title: "Test alert", key: "k2", what: "A test." }, "onlyjewishgirls.com");
    expect(sent.map((s) => s.url)).toEqual([PLUNK, PLUNK]);
    expect(h.d1.one<{ provider: string; status: string; error: string }>("SELECT status, provider, error FROM security_alerts")).toMatchObject({
      status: "failed",
      provider: "plunk",
      error: expect.stringMatching(/^Plunk answered 503/),
    });
  });

  it("a Plunk 4xx is not retried and is recorded as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(422, 200);
    await recordAndSend({ event: "test", title: "Test alert", key: "k4", what: "A test." }, "onlyjewishgirls.com");
    expect(sent).toHaveLength(1);
    expect(h.d1.one<{ status: string; error: string }>("SELECT status, error FROM security_alerts")).toMatchObject({ status: "failed", error: expect.stringMatching(/^Plunk answered 422/) });
  });

  it("a failed reset email never breaks the request", async () => {
    await makeUser({ username: "failer" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(500, 500, 500, 500);
    const r = await call(forgot, "/api/auth/forgot-password", { body: { identifier: "failer" } });
    expect(r.data.ok).toBe(true);
    await settle();
  });
});
