import Database from "better-sqlite3";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { base32Decode, hotp, totpStep } from "../../src/server/totp";
import { E2E_DATA_DIR } from "../../playwright.config";

const user = {
  firstName: "Chaya",
  middleName: "Rivka",
  lastName: "Goldberg",
  email: "chaya@example.com",
  username: "chaya_test",
  phone: "212-555-0147",
  password: "Xq7#Rv!Kz9Wm$Pd2",
};

const shots = process.env.SCREENSHOT_DIR;
async function screenshot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

function totp(secret: string, stepOffset = 0) {
  return hotp(base32Decode(secret), totpStep(Date.now()) + stepOffset);
}

async function addVirtualAuthenticator(page: Page) {
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

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
}

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
}

function db() {
  return new Database(path.join(E2E_DATA_DIR, "app.db"));
}

test("register, set up passkey + authenticator app, sign in every way, keep a streak", async ({ page }) => {
  test.setTimeout(120_000);
  // Hydration mismatches and uncaught errors show up here. 4xx responses are expected (wrong codes etc.).
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/status of 4\d\d/.test(msg.text())) consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  await addVirtualAuthenticator(page);
  let secret = "";
  let recoveryCodes: string[] = [];

  await test.step("registration enforces the middle-name checkbox and the password rules", async () => {
    await page.goto("/register");
    await page.getByLabel("First name").fill(user.firstName);
    await page.getByLabel("Last name").fill(user.lastName);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Country code").selectOption("US");
    await page.locator("#phone").fill(user.phone);

    // Weak password: the live checklist calls out each problem.
    await page.locator("#password").fill("P@ssw0rd123chaya");
    const rule = (id: string) => page.locator(`[data-rule="${id}"]`);
    await expect(rule("dictionary")).toHaveAttribute("data-state", "bad");
    await expect(rule("dictionary")).toContainText("password");
    await expect(rule("personal")).toHaveAttribute("data-state", "bad");
    await expect(rule("sequence")).toHaveAttribute("data-state", "bad");
    await expect(rule("uppercase")).toHaveAttribute("data-state", "bad");

    // Missing middle name is an error unless the box is checked.
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Middle name is required")).toBeVisible();
    await page.getByLabel("No middle name").check();
    await expect(page.getByLabel("Middle name", { exact: true })).toBeDisabled();
    await page.getByLabel("No middle name").uncheck();
    await page.getByLabel("Middle name", { exact: true }).fill(user.middleName);

    await page.locator("#password").fill(user.password);
    for (const id of ["length", "uppercase", "lowercase", "symbol", "number", "dictionary", "personal", "sequence"]) {
      await expect(rule(id)).toHaveAttribute("data-state", "ok");
    }
    await page.locator("#confirmPassword").fill(user.password);
    await expect(page.getByText("✓ Passwords match")).toBeVisible();
    await screenshot(page, "1-register");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL("/setup-mfa");
  });

  await test.step("the site is off-limits until MFA is set up", async () => {
    await page.goto("/home");
    await expect(page).toHaveURL("/setup-mfa");
  });

  await test.step("add a passkey", async () => {
    await page.getByRole("button", { name: /Create a passkey/ }).click();
    await expect(page.locator('[data-step="1"]')).toHaveAttribute("data-done", "true");
  });

  await test.step("connect an authenticator app", async () => {
    await page.getByRole("button", { name: /Set up authenticator app/ }).click();
    secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
    await screenshot(page, "2-setup-mfa");
    await page.getByLabel("6-digit code").fill("000000");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("That code didn't match")).toBeVisible();
    await page.getByLabel("6-digit code").fill(totp(secret));
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator('[data-step="2"]')).toHaveAttribute("data-done", "true");
  });

  await test.step("save recovery codes and land on the streak page", async () => {
    await page.getByRole("button", { name: "Show my recovery codes" }).click();
    recoveryCodes = await page.getByTestId("recovery-codes").locator("li").allInnerTexts();
    expect(recoveryCodes).toHaveLength(10);
    const proceed = page.getByRole("button", { name: /Continue/ });
    await expect(proceed).toBeDisabled();
    await page.getByLabel("I saved these somewhere safe").check();
    await proceed.click();
    await expect(page).toHaveURL("/home");
    await expect(page.getByTestId("streak-count")).toHaveText("1");
    await expect(page.getByTestId("streak-banner")).toContainText("Your streak has started");
    await screenshot(page, "3-home-streak");
  });

  await test.step("wrong password is rejected without saying which part was wrong", async () => {
    await signOut(page);
    await signIn(page, user.username, "Xq7#Rv!Kz9Wm$Pd3");
    await expect(page.getByText("Incorrect username/email or password.")).toBeVisible();
  });

  await test.step("sign in with password + passkey", async () => {
    await signIn(page, user.username, user.password);
    await expect(page).toHaveURL("/login/verify");
    await page.goto("/home");
    await expect(page).toHaveURL("/login/verify"); // password alone isn't enough
    await page.getByRole("button", { name: /Use my passkey/ }).click();
    await expect(page).toHaveURL("/home");
    await expect(page.getByTestId("streak-banner")).toContainText("Your streak has started");
  });

  await test.step("sign in with password + authenticator code", async () => {
    await signOut(page);
    await signIn(page, user.email, user.password);
    await page.getByRole("button", { name: "Use my authenticator app" }).click();
    // The setup code can't be replayed; the next one works.
    await page.getByLabel(/6-digit code/).fill(totp(secret, 1));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL("/home");
  });

  await test.step("sign in with password + recovery code, which then stops working", async () => {
    await signOut(page);
    await signIn(page, user.username, user.password);
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Recovery code").fill(recoveryCodes[0].toLowerCase());
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL("/home");

    await signOut(page);
    await signIn(page, user.username, user.password);
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("isn't valid or was already used")).toBeVisible();
    await page.getByRole("button", { name: "Use a passkey" }).click();
    await page.getByRole("button", { name: /Use my passkey/ }).click();
    await expect(page).toHaveURL("/home");
  });

  await test.step("checking in on a new day within 30 hours extends the streak", async () => {
    const conn = db();
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    conn
      .prepare(
        "UPDATE users SET streak_count = 5, streak_longest = 5, streak_last_activity_at = ?, streak_last_counted_date = ? WHERE username = ?",
      )
      .run(Date.now() - 20 * 3_600_000, yesterday, user.username);
    conn.close();
    await page.reload();
    await expect(page.getByTestId("streak-count")).toHaveText("6");
    await expect(page.getByTestId("streak-banner")).toContainText("Streak extended");
  });

  await test.step("missing the deadline starts over", async () => {
    const conn = db();
    // 100 hours is past even a 3-day Yom Tov's leeway.
    conn
      .prepare("UPDATE users SET streak_last_activity_at = ?, streak_last_counted_date = ? WHERE username = ?")
      .run(Date.now() - 100 * 3_600_000, "2000-01-01", user.username);
    conn.close();
    await page.reload();
    await expect(page.getByTestId("streak-count")).toHaveText("1");
    await expect(page.getByTestId("streak-banner")).toContainText("Your 6-day streak ended");
    await expect(page.getByText("Longest streak: 6")).toBeVisible();
  });

  expect(consoleErrors).toEqual([]);
});

test("usernames and emails must be unique", async ({ request }) => {
  const register = (data: Record<string, unknown>) =>
    request.post("/api/auth/register", {
      headers: { Origin: "http://localhost:3100" },
      data: {
        firstName: "Tova",
        middleName: "",
        noMiddleName: true,
        lastName: "Weiss",
        phoneCountry: "US",
        phone: "212-555-0199",
        password: "Tn4&Wb!Qj8Hy%Lc5",
        confirmPassword: "Tn4&Wb!Qj8Hy%Lc5",
        ...data,
      },
    });

  expect((await register({ email: "tova@example.com", username: "tova_w" })).status()).toBe(200);
  const res = await register({ email: "TOVA@example.com", username: "TOVA_W" });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.fields.username).toBe("That username is taken");
  expect(body.fields.email).toBe("An account with this email already exists");
});

test("cross-site requests are blocked", async ({ request }) => {
  const res = await request.post("/api/auth/login", {
    headers: { Origin: "https://evil.example" },
    data: { identifier: user.username, password: user.password },
  });
  expect(res.status()).toBe(403);
});
