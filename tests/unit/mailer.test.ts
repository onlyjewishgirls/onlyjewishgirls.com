import { afterEach, describe, expect, it, vi } from "vitest";

let env: Record<string, string> = {};
vi.mock("@/server/env", () => ({ cfEnv: () => env }));
const { deliverEmail, emailConfigured, sendEmail } = await import("@/server/mailer");

const email = { to: "reader@example.com", subject: "Reset", text: "Link", html: "<p>Link</p>" };
const keys = { EMAIL_API_KEY: "re_x", PLUNK_API_KEY: "sk_x", EMAIL_FROM: "OnlyJewishGirls <no-reply@onlyjewishgirls.com>" };

function answer(...statuses: (number | "throw")[]) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const status = statuses.shift();
    if (status === "throw") throw new Error("network");
    return new Response("{}", { status });
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PLUNK = "https://next-api.useplunk.com/v1/send";
const RESEND = "https://api.resend.com/emails";

describe("sendEmail (PORTAL-STANDARD §8: Plunk primary)", () => {
  it("uses Plunk first and leaves Resend alone when Plunk sends", async () => {
    env = keys;
    const sent = answer(200);
    expect(await sendEmail(email, { local: false })).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([PLUNK]);
    expect(sent[0].body).toEqual({
      from: { name: "OnlyJewishGirls", email: "no-reply@onlyjewishgirls.com" },
      to: "reader@example.com",
      subject: "Reset",
      body: "<p>Link</p>",
    });
  });

  it("falls back to Resend when Plunk refuses or is unreachable", async () => {
    env = keys;
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const first of [429, 500, "throw"] as const) {
      const sent = answer(first, 200);
      expect(await deliverEmail(email, { local: false })).toEqual({ ok: true, provider: "Resend", error: null });
      expect(sent.map((s) => s.url)).toEqual([PLUNK, RESEND]);
      expect(sent[1].body).toMatchObject({ from: keys.EMAIL_FROM, to: ["reader@example.com"] });
    }
  });

  it("reports failure when both fail, with the last provider's answer", async () => {
    env = keys;
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(500, 503);
    expect(await deliverEmail(email, { local: false })).toMatchObject({ ok: false, provider: "Resend", error: expect.stringMatching(/^Resend answered 503/) });
  });

  it("PLUNK_API_KEY alone is a complete set-up (default sender), Resend alone still works, EMAIL_PRIMARY=resend flips the order", async () => {
    env = { PLUNK_API_KEY: "sk_x" };
    expect(emailConfigured()).toBe(true);
    let sent = answer(200);
    expect(await deliverEmail(email, { local: false })).toEqual({ ok: true, provider: "Plunk", error: null });
    expect(sent[0].body).toMatchObject({ from: { name: "OnlyJewishGirls", email: "no-reply@onlyjewishgirls.com" } });

    env = { PLUNK_API_KEY: "sk_x", PLUNK_API_URL: "https://plunk.example.com/api/v1/send" };
    sent = answer(200);
    await sendEmail(email, { local: false });
    expect(sent[0].url).toBe("https://plunk.example.com/api/v1/send");

    env = { EMAIL_API_KEY: "re_x" };
    sent = answer(200);
    expect(await deliverEmail(email, { local: false })).toMatchObject({ ok: true, provider: "Resend" });

    env = { ...keys, EMAIL_PRIMARY: "resend" };
    sent = answer(200);
    await sendEmail(email, { local: false });
    expect(sent[0].url).toBe(RESEND);

    env = { EMAIL_FROM: "a@b.com" };
    expect(emailConfigured()).toBe(false);
  });
});
