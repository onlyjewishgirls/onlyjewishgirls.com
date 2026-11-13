import { readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2E_ORIGIN } from "../../playwright.config";
import { screenshot } from "./helpers";

// No pass here: these run as a stranger would arrive.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * PORTAL-STANDARD §10 in the real Worker (worker.ts + run_worker_first): nothing loads without a
 * solved CAPTCHA, static files included, and the wall's answer comes before the app's.
 */
test("the CAPTCHA wall stands in front of every page, file and API", async ({ page, request }) => {
  const res = await page.goto("/login");
  expect(res?.status()).toBe(403);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Checking that you're human before loading OnlyJewishGirls.")).toBeVisible();
  expect(res?.headers()["content-security-policy"]).toContain("https://challenges.cloudflare.com");
  await screenshot(page, "captcha-challenge");

  // A real file from the build (served by the assets layer, which now runs behind the Worker).
  const chunk = readdirSync(".open-next/assets/_next/static/chunks").find((f) => f.endsWith(".js"));
  expect(chunk).toBeTruthy();
  for (const path of ["/favicon.ico", "/robots.txt", "/console/console.js", `/_next/static/chunks/${chunk}`, "/api/console/bootstrap", "/no-such-page", "/.env"]) {
    const r = await request.get(path, { headers: { Accept: "application/json" } });
    expect(r.status(), path).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, code: "captcha_required" });
  }
  const login = await request.post("/api/auth/login", { headers: { Origin: E2E_ORIGIN }, data: { identifier: "x", password: "y" } });
  expect(login.status()).toBe(403);

  // Solving it (Cloudflare's test keys accept the dummy token on localhost) lets the same browser in.
  const verify = await page.request.post("/__gate/verify", {
    form: { token: "XXXX.DUMMY.TOKEN.XXXX", return: "/login" },
    headers: { Origin: E2E_ORIGIN },
    maxRedirects: 0,
  });
  expect(verify.status()).toBe(303);
  expect(verify.headers()["location"]).toBe("/login");
  const signIn = await page.goto("/login");
  expect(signIn?.status()).toBe(200);
  expect(signIn?.headers()["vary"]).toContain("Cookie");
  await expect(page.getByLabel("Username or email")).toBeVisible();
});
