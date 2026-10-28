import { afterEach, describe, expect, it, vi } from "vitest";

let env: Record<string, string> = {};
vi.mock("@/server/env", () => ({ cfEnv: () => env }));
const { emailConfigured, sendEmail } = await import("@/server/mailer");

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

describe("sendEmail", () => {
  it("uses Resend and leaves Plunk alone when Resend sends", async () => {
    env = keys;
    const sent = answer(200);
    expect(await sendEmail(email, { local: false })).toBe(true);
    expect(sent.map((s) => s.url)).toEqual(["https://api.resend.com/emails"]);
  });

  it("falls back to Plunk when Resend refuses or is unreachable", async () => {
    env = keys;
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const first of [429, "throw"] as const) {
      const sent = answer(first, 200);
      expect(await sendEmail(email, { local: false })).toBe(true);
      expect(sent[1].url).toBe("https://next-api.useplunk.com/v1/send");
      expect(sent[1].body).toEqual({
        from: { name: "OnlyJewishGirls", email: "no-reply@onlyjewishgirls.com" },
        to: "reader@example.com",
        subject: "Reset",
        body: "<p>Link</p>",
      });
    }
  });

  it("reports failure when both fail", async () => {
    env = keys;
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer(500, 500);
    expect(await sendEmail(email, { local: false })).toBe(false);
  });

  it("tries Plunk first with EMAIL_PRIMARY=plunk, and Plunk alone is enough", async () => {
    env = { ...keys, EMAIL_PRIMARY: "plunk" };
    const sent = answer(200);
    expect(await sendEmail(email, { local: false })).toBe(true);
    expect(sent[0].url).toBe("https://next-api.useplunk.com/v1/send");
    env = { PLUNK_API_KEY: "sk_x", EMAIL_FROM: "a@b.com" };
    expect(emailConfigured()).toBe(true);
    env = { EMAIL_FROM: "a@b.com" };
    expect(emailConfigured()).toBe(false);
  });
});
