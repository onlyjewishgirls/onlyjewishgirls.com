import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { base32Decode, hotp, totpStep } from "../../src/server/totp";
import { E2E_DATA_DIR } from "../../playwright.config";

const shots = process.env.SCREENSHOT_DIR;
export async function screenshot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

export function totp(secret: string, stepOffset = 0) {
  return hotp(base32Decode(secret), totpStep(Date.now()) + stepOffset);
}

export async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
}

export async function signIn(page: Page, identifier: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Runs SQL against the local D1 database that `wrangler dev` is serving. */
export function sql(statement: string) {
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_DATA_DIR, "--command", statement], {
    stdio: "pipe",
  });
}

/** Same query, returning rows. */
export function query<T = Record<string, unknown>>(statement: string): T[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_DATA_DIR, "--json", "--command", statement],
    { stdio: ["ignore", "pipe", "pipe"] },
  ).toString();
  return (JSON.parse(out) as { results: T[] }[])[0].results;
}

/** On /setup-mfa: passkey, authenticator app and recovery codes. Returns the TOTP secret. */
export async function completeMfaSetup(page: Page): Promise<string> {
  await page.getByRole("button", { name: /Create a passkey/ }).click();
  await expect(page.locator('[data-step="1"]')).toHaveAttribute("data-done", "true");
  await page.getByRole("button", { name: /Set up authenticator app/ }).click();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator('[data-step="2"]')).toHaveAttribute("data-done", "true");
  await page.getByRole("button", { name: "Show my recovery codes" }).click();
  await expect(page.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
  await page.getByLabel("I saved these somewhere safe").check();
  await page.getByRole("button", { name: /Continue/ }).click();
  return secret;
}

/** Fails the test on hydration mismatches and uncaught errors. 4xx responses are expected. */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/status of 4\d\d/.test(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}
