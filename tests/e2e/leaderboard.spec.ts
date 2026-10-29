import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  addVirtualAuthenticator,
  collectConsoleErrors,
  completeMfaSetup,
  query,
  screenshot,
  signIn,
  signOut,
  sql,
  totp,
} from "./helpers";

const ORIGIN = "http://localhost:3100";
const HOUR = 3_600_000;

const viewer = {
  firstName: "Leah",
  lastName: "Friedman",
  email: "leah.viewer@example.com",
  username: "lb_viewer",
  phone: "212-555-0191",
  password: "Wd7$Nq!Fz2Lx#Ht5",
};

/**
 * Adds a member straight to the database with a given streak. Their last check-in was
 * `hoursAgo` ago in an ordinary week, so whether the streak is still alive doesn't depend on today's date.
 */
function seed(username: string, o: { streak: number; hoursAgo: number; suspended?: boolean }) {
  const last = Date.now() - o.hoursAgo * HOUR;
  const date = new Date(last).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  sql(
    `INSERT INTO users (first_name, last_name, email, username, username_lower, phone_e164, password_hash, time_zone,
                        webauthn_user_id, created_at, streak_count, streak_longest, streak_last_activity_at,
                        streak_last_counted_date, streak_started_at, suspended_at, search_name)
     VALUES ('Seed', 'Person', '${username}@seed.example', '${username}', '${username}', '+12125550100', 'not-a-hash',
             'America/New_York', 'seed-${username}', ${Date.now()}, ${o.streak}, ${o.streak}, ${last}, '${date}', ${last},
             ${o.suspended ? Date.now() : "NULL"}, 'seed person')`,
  );
}

test("the streak leaderboard pops up after signing in and ranks only live streaks", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const errors = collectConsoleErrors(page);
  await addVirtualAuthenticator(page);

  // Within 30 hours of a check-in the streak is alive; 6.9 days is past the longest any deadline can reach.
  seed("lb_alice", { streak: 400, hoursAgo: 2 });
  seed("lb_bob", { streak: 365, hoursAgo: 20 });
  seed("lb_carol", { streak: 365, hoursAgo: 25 });
  seed("lb_dina", { streak: 120, hoursAgo: 10 });
  seed("lb_eli", { streak: 50, hoursAgo: 28 });
  seed("lb_lapsed", { streak: 900, hoursAgo: 165 });
  seed("lb_ancient", { streak: 950, hoursAgo: 480 });
  seed("lb_suspended", { streak: 500, hoursAgo: 1, suspended: true });
  seed("lb_none", { streak: 0, hoursAgo: 1 });

  const popup = page.getByTestId("leaderboard-popup");
  const rows = (scope: Page | Locator = page) => scope.locator("[data-testid=leaderboard-list] li[data-rank]");
  const names = async (scope: Page | Locator = page) => rows(scope).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.username));
  const ranks = async (scope: Page | Locator = page) => rows(scope).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.rank));
  const secret = await test.step("a new member signs up", async () => {
    await page.goto("/register");
    await page.getByLabel("First name").fill(viewer.firstName);
    await page.getByLabel("No middle name").check();
    await page.getByLabel("Last name").fill(viewer.lastName);
    await page.getByLabel("Email").fill(viewer.email);
    await page.getByLabel("Username").fill(viewer.username);
    await page.locator("#phone").fill(viewer.phone);
    await page.locator("#password").fill(viewer.password);
    await page.locator("#confirmPassword").fill(viewer.password);
    await expect(page.locator('[data-rule="dictionary"]')).toHaveAttribute("data-state", "ok");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL("/setup-mfa");
    const secret = await completeMfaSetup(page);
    await expect(page).toHaveURL("/home");
    return secret;
  });

  await test.step("the leaderboard is the first thing they see", async () => {
    await expect(page.getByRole("dialog", { name: /Streak leaderboard/ })).toBeVisible();
    // Longest live streak first. Equal streaks share a rank. Lapsed, suspended and zero streaks aren't listed.
    await expect(rows(popup).first()).toHaveAttribute("data-rank", "1");
    expect((await names(popup)).slice(0, 5)).toEqual(["lb_alice", "lb_bob", "lb_carol", "lb_dina", "lb_eli"]);
    expect((await ranks(popup)).slice(0, 5)).toEqual(["1", "2", "2", "4", "5"]);
    await expect(popup.getByText("lb_lapsed")).toHaveCount(0);
    await expect(popup.getByText("lb_ancient")).toHaveCount(0);
    await expect(popup.getByText("lb_suspended")).toHaveCount(0);
    await expect(popup.getByText("lb_none")).toHaveCount(0);

    // They're on it too, exactly once, with their one-day streak.
    await expect(popup.locator('[data-you="true"]')).toHaveCount(1);
    await expect(popup.getByTestId("leaderboard-standing")).toHaveText(/^You're (tied for )?#\d+( of \d+ live streaks)? with a 1-day streak\.$/);
    await screenshot(page, "leaderboard-1-popup");

    // A real modal: keyboard focus stays inside it, and the page behind can't be clicked.
    await page.keyboard.press("Tab");
    expect(await popup.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    const behindIsClickable = await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign out")!;
      const { x, y, width, height } = button.getBoundingClientRect();
      return document.elementFromPoint(x + width / 2, y + height / 2) === button;
    });
    expect(behindIsClickable).toBe(false);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  await test.step("it doesn't come back during the same sign-in", async () => {
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500); // the popup opens as soon as the page is ready; give it the chance
    await expect(page.getByTestId("streak-card")).toBeVisible();
    await expect(popup).toBeHidden();
  });

  await test.step("the full leaderboard is one click away", async () => {
    await page.getByRole("link", { name: "Leaderboard" }).first().click();
    await expect(page).toHaveURL("/leaderboard");
    await expect(page.getByRole("heading", { name: /Streak leaderboard/ })).toBeVisible();
    expect((await names()).slice(0, 5)).toEqual(["lb_alice", "lb_bob", "lb_carol", "lb_dina", "lb_eli"]);
    const you = page.locator('[data-testid=leaderboard-list] li[data-you="true"]');
    await expect(you).toHaveCount(1);
    await expect(you).toHaveAttribute("data-username", viewer.username);
    await expect(you).toContainText("1 day");
    await screenshot(page, "leaderboard-2-page");

    // Only usernames and streak lengths leave the server: no ids, names, emails or phone numbers.
    const html = await page.content();
    for (const secretBit of ["seed.example", "@example.com", "212-555", "+12125550100", "not-a-hash", "Seed Person", "webauthn"]) {
      expect(html, secretBit).not.toContain(secretBit);
    }
  });

  await test.step("the board follows the rules: suspending someone or reviving a streak shows up straight away", async () => {
    sql(`UPDATE users SET suspended_at = ${Date.now()} WHERE username = 'lb_bob'`);
    sql(`UPDATE users SET streak_last_activity_at = ${Date.now() - HOUR} WHERE username = 'lb_lapsed'`);
    await page.reload();
    // lb_lapsed (900 days, checked in an hour ago) is back in front; lb_bob has gone.
    expect((await names()).slice(0, 5)).toEqual(["lb_lapsed", "lb_alice", "lb_carol", "lb_dina", "lb_eli"]);
    await expect(page.getByText("lb_bob")).toHaveCount(0);
    // And a member who lets a streak lapse drops off.
    sql(`UPDATE users SET streak_last_activity_at = ${Date.now() - 165 * HOUR} WHERE username = 'lb_lapsed'`);
    await page.reload();
    await expect(page.getByText("lb_lapsed")).toHaveCount(0);
  });

  await test.step("signing in again brings it back", async () => {
    await signOut(page);
    await signIn(page, viewer.username, viewer.password);
    await page.getByRole("button", { name: "Use my authenticator app" }).click();
    await page.getByLabel(/6-digit code/).fill(totp(secret, 1));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL("/home");
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId("leaderboard-standing")).toContainText("1-day streak");
    await popup.getByRole("link", { name: "Full leaderboard" }).click();
    await expect(page).toHaveURL("/leaderboard");
  });

  await test.step("it fits a phone", async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/home");
    // Pretend this is the first view of a new sign-in.
    await page.evaluate(() => localStorage.removeItem("ojg-leaderboard-shown"));
    await page.reload();
    await expect(popup).toBeVisible();
    const box = (await popup.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(667);
    await expect(popup.getByRole("button", { name: "Continue" })).toBeInViewport();
    await screenshot(page, "leaderboard-3-popup-phone");
    await popup.getByRole("button", { name: "Continue" }).click();
    // The nav shows just the trophy on a narrow screen, and nothing runs off the side.
    await expect(page.getByRole("link", { name: "Leaderboard" }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/leaderboard");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, "leaderboard-4-page-phone");
  });

  await test.step("visitors who aren't signed in see none of it", async () => {
    const guest = await browser.newContext({ baseURL: ORIGIN });
    const g = await guest.newPage();
    await g.goto("/");
    await g.waitForLoadState("networkidle");
    await expect(g.getByTestId("leaderboard-popup")).toHaveCount(0);
    await expect(g.getByRole("link", { name: "Leaderboard" })).toHaveCount(0);
    await g.goto("/leaderboard");
    await expect(g).toHaveURL("/login");
    await guest.close();
  });

  expect(errors).toEqual([]);

  // The index keeps the board cheap to read (see migration 6).
  const plan = query<{ detail: string }>(
    `EXPLAIN QUERY PLAN SELECT id FROM users WHERE streak_count > 0 AND streak_last_activity_at >= 0 AND suspended_at IS NULL
     ORDER BY streak_count DESC, id DESC LIMIT 200`,
  );
  expect(plan.map((p) => p.detail).join(" ")).toContain("users_streak");
});
