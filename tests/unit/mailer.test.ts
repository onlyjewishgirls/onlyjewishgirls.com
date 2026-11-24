import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let env: Record<string, string> = {};
vi.mock("@/server/env", () => ({ cfEnv: () => env }));
const { deliverEmail, emailConfigured, sendEmail } = await import("@/server/mailer");
const { mailRetry } = await import("@/server/mail-core");

const email = { to: "reader@example.com", subject: "Reset", text: "Link", html: "<p>Link</p>" };
const PLUNK = "https://next-api.useplunk.com/v1/send";

function answer(...statuses: (number | "throw")[]) {
  const sent: { url: string; auth: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, auth: new Headers(init.headers).get("authorization") ?? "", body: JSON.parse(String(init.body)) });
    const status = statuses.shift() ?? 200;
    if (status === "throw") throw new Error("network");
    return new Response(status >= 400 ? "nope" : "{}", { status });
  });
  return sent;
}

beforeEach(() => {
  mailRetry.delayMs = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendEmail (PORTAL-STANDARD §8: Plunk only)", () => {
  it("sends through Plunk with a Bearer key and Plunk's JSON body", async () => {
    env = { PLUNK_API_KEY: "sk_x", EMAIL_FROM: "OnlyJewishGirls <no-reply@onlyjewishgirls.com>" };
    const sent = answer(200);
    expect(await sendEmail(email, { local: false })).toBe(true);
    expect(sent).toEqual([
      {
        url: PLUNK,
        auth: "Bearer sk_x",
        body: { from: { name: "OnlyJewishGirls", email: "no-reply@onlyjewishgirls.com" }, to: "reader@example.com", subject: "Reset", body: "<p>Link</p>" },
      },
    ]);
  });

  it("PLUNK_API_KEY alone is a complete set-up (default sender); PLUNK_API_URL overrides the endpoint", async () => {
    env = { PLUNK_API_KEY: "sk_x" };
    expect(emailConfigured()).toBe(true);
    let sent = answer(200);
    expect(await deliverEmail(email, { local: false })).toEqual({ ok: true, provider: "plunk", error: null });
    expect(sent[0].body).toMatchObject({ from: { name: "OnlyJewishGirls", email: "no-reply@onlyjewishgirls.com" } });

    env = { PLUNK_API_KEY: "sk_x", PLUNK_API_URL: "https://plunk.example.com/api/v1/send" };
    sent = answer(200);
    await sendEmail(email, { local: false });
    expect(sent[0].url).toBe("https://plunk.example.com/api/v1/send");
  });

  it("never uses a RESEND_API_KEY (or the old EMAIL_API_KEY) that is still set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    env = { PLUNK_API_KEY: "sk_x", RESEND_API_KEY: "re_x", EMAIL_API_KEY: "re_x", EMAIL_PRIMARY: "resend" };
    let sent = answer(200);
    expect(await sendEmail(email, { local: false })).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([PLUNK]);
    expect(sent[0].auth).toBe("Bearer sk_x");
    // Even when Plunk fails twice, nothing goes anywhere but Plunk.
    sent = answer(500, 503);
    expect(await deliverEmail(email, { local: false })).toMatchObject({ ok: false, provider: "plunk" });
    expect(sent.map((s) => s.url)).toEqual([PLUNK, PLUNK]);
    expect(sent.every((s) => s.auth === "Bearer sk_x")).toBe(true);

    // Without PLUNK_API_KEY, those keys don't make mail configured, and nothing is fetched.
    env = { RESEND_API_KEY: "re_x", EMAIL_API_KEY: "re_x" };
    expect(emailConfigured()).toBe(false);
    sent = answer(200);
    expect(await deliverEmail(email, { local: false })).toMatchObject({ ok: false, provider: null });
    expect(sent).toEqual([]);
  });

  it("retries a 5xx or a network error once, then succeeds", async () => {
    env = { PLUNK_API_KEY: "sk_x" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const first of [500, 503, "throw"] as const) {
      const sent = answer(first, 200);
      expect(await deliverEmail(email, { local: false })).toEqual({ ok: true, provider: "plunk", error: null });
      expect(sent.map((s) => s.url)).toEqual([PLUNK, PLUNK]);
    }
  });

  it("retries a 5xx only once, then reports the failure (no throw)", async () => {
    env = { PLUNK_API_KEY: "sk_x" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    let sent = answer(500, 502, 200);
    expect(await deliverEmail(email, { local: false })).toEqual({ ok: false, provider: "plunk", error: "Plunk answered 502: nope" });
    expect(sent).toHaveLength(2);
    sent = answer("throw", "throw");
    expect(await deliverEmail(email, { local: false })).toEqual({ ok: false, provider: "plunk", error: "Plunk: network" });
    expect(sent).toHaveLength(2);
  });

  it("waits the retry pause before the second try", async () => {
    env = { PLUNK_API_KEY: "sk_x" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    mailRetry.delayMs = 50;
    answer(500, 200);
    const t0 = Date.now();
    expect((await deliverEmail(email, { local: false })).ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it("does not retry a 4xx", async () => {
    env = { PLUNK_API_KEY: "sk_x" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [400, 401, 422, 429]) {
      const sent = answer(status, 200);
      expect(await deliverEmail(email, { local: false })).toEqual({ ok: false, provider: "plunk", error: `Plunk answered ${status}: nope` });
      expect(sent).toHaveLength(1);
    }
  });

  it("without PLUNK_API_KEY, mail reads as not configured", async () => {
    env = { EMAIL_FROM: "a@b.com" };
    expect(emailConfigured()).toBe(false);
    env = { PLUNK_API_KEY: "  " };
    expect(emailConfigured()).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = answer(200);
    expect(await sendEmail(email, { local: false })).toBe(false);
    expect(sent).toEqual([]);
  });
});
