import { defineConfig, devices } from "@playwright/test";

/** E2E_PORT / E2E_INSPECTOR_PORT move the test server when 3100 (or wrangler's default inspector port) is taken. */
const PORT = Number(process.env.E2E_PORT) || 3100;
const INSPECTOR = process.env.E2E_INSPECTOR_PORT ? ` --inspector-port ${Number(process.env.E2E_INSPECTOR_PORT)}` : "";
export const E2E_ORIGIN = `http://localhost:${PORT}`;
/** Local D1 database (and other Wrangler state) for the test run; wiped at start. */
export const E2E_DATA_DIR = ".data/e2e";
/** The CAPTCHA pass global-setup.ts obtains once; every browser and API context starts with it. */
export const E2E_PASS_STATE = ".data/e2e-captcha-pass.json";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // The CAPTCHA wall (PORTAL-STANDARD §10) is in front of everything: solve it once (test keys, localhost).
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: E2E_ORIGIN,
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
    storageState: E2E_PASS_STATE,
    // Lets environments with a preinstalled Chromium skip `npx playwright install`.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Builds with OpenNext and serves the real Worker in workerd, with a fresh local D1 database.
    // ensure-dev-vars.mjs puts Cloudflare's always-pass Turnstile test keys in .dev.vars.
    command: `node scripts/ensure-dev-vars.mjs && rm -rf ${E2E_DATA_DIR} && npx wrangler dev --port ${PORT} --ip 127.0.0.1${INSPECTOR} --persist-to ${E2E_DATA_DIR}`,
    // Ready when it answers at all: before the pass, that is the CAPTCHA wall's 403.
    url: `${E2E_ORIGIN}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
