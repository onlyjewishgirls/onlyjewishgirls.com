import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
/** Local D1 database (and other Wrangler state) for the test run; wiped at start. */
export const E2E_DATA_DIR = ".data/e2e";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
    // Lets environments with a preinstalled Chromium skip `npx playwright install`.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Builds with OpenNext and serves the real Worker in workerd, with a fresh local D1 database.
    command: `node scripts/ensure-dev-vars.mjs && rm -rf ${E2E_DATA_DIR} && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to ${E2E_DATA_DIR}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
