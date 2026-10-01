import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export const E2E_DATA_DIR = ".data/e2e";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Lets environments with a preinstalled Chromium skip `npx playwright install`.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Fresh database for every run. Build first with `npm run build`.
    command: `rm -rf ${E2E_DATA_DIR} && next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: {
      APP_ORIGIN: `http://localhost:${PORT}`,
      DATA_DIR: E2E_DATA_DIR,
      APP_SECRET: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    },
  },
});
