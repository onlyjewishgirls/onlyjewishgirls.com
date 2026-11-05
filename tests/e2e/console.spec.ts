import { expect, test } from "@playwright/test";
import { addVirtualAuthenticator, blockPasskeyAutofill, collectConsoleErrors, completeMfaSetup, query, screenshot, sql } from "./helpers";

const owner = {
  firstName: "Shira",
  lastName: "Adler",
  email: "shira@example.com",
  username: "shira_owner",
  phone: "212-555-0166",
  password: "Wm7!Kq#Zt4Vx$Hp2",
};

/** PORTAL-STANDARD §5: /admin is the shared Console kit over /api/console/*. */
test("the admin console is the Console kit, with this site's features", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  await addVirtualAuthenticator(page);
  await blockPasskeyAutofill(page);

  await page.goto("/register");
  await page.getByLabel("First name").fill(owner.firstName);
  await page.getByLabel("No middle name").check();
  await page.getByLabel("Last name").fill(owner.lastName);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Username").fill(owner.username);
  await page.locator("#phone").fill(owner.phone);
  await page.locator("#password").fill(owner.password);
  await page.locator("#confirmPassword").fill(owner.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await completeMfaSetup(page);
  await expect(page).toHaveURL("/home");
  sql(`UPDATE users SET role = 'owner' WHERE username = '${owner.username}'`);
  const ownerId = query<{ id: number }>(`SELECT id FROM users WHERE username = '${owner.username}'`)[0].id;

  await test.step("the sidebar shows the sections this site supports, and only those", async () => {
    await page.goto("/admin");
    const side = page.locator(".cx-side");
    await expect(side).toBeVisible();
    for (const label of ["Overview", "People", "Roles & permissions", "Streaks", "Settings", "Security", "IP allowlist", "Deny list", "Sessions", "Audit log", "Security alerts"]) {
      // A sidebar entry may carry a count badge ("Deny list 2 waiting"), so match the start of the name.
      const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+ waiting)?$`);
      await expect(side.getByRole("link", { name }).first()).toBeVisible();
    }
    for (const label of ["Invitations", "Devices", "Country rule"]) await expect(side.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    // Site pages the kit doesn't cover stay linked.
    await expect(page.getByRole("link", { name: "Visitor log (pages, referrers)" })).toHaveAttribute("href", "/admin/visitors");
    await screenshot(page, "console-1-overview");
  });

  await test.step("the owner sets their own streak from their record (§4)", async () => {
    await page.goto(`/admin#people/${ownerId}/streak`);
    const input = page.getByLabel("Set streak to (days)");
    await expect(input).toBeVisible();
    await input.fill("12");
    await page.getByRole("button", { name: "Set streak" }).click();
    await page.getByRole("button", { name: "Set it" }).click();
    await expect(page.getByText("Streak set to 12.").first()).toBeVisible();
    await screenshot(page, "console-2-streak");
    expect(query<{ streak_count: number }>(`SELECT streak_count FROM users WHERE id = ${ownerId}`)[0].streak_count).toBe(12);
    expect(query(`SELECT kind FROM streak_restores WHERE user_id = ${ownerId}`)).toEqual([{ kind: "admin" }]);
  });

  await test.step("a security-alert link opens the audit entry", async () => {
    const id = query<{ id: number }>("SELECT id FROM events WHERE type = 'admin.set_streak' ORDER BY id DESC LIMIT 1")[0].id;
    await page.goto(`/admin#audit/${id}`);
    await expect(page.getByText(/Changed the streak/).first()).toBeVisible();
    // Recorded in security_alerts (email isn't configured in tests, so delivery failed — and says why).
    await expect
      .poll(() => query<{ status: string }>(`SELECT status FROM security_alerts WHERE event = 'streak_set' AND user_id = ${ownerId}`).map((r) => r.status))
      .toEqual(["failed"]);
  });

  await test.step("phone width: the sidebar becomes a drawer and nothing scrolls sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin#overview");
    await expect(page.locator(".cx-side")).toBeAttached();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await screenshot(page, "console-3-phone");
  });

  expect(errors).toEqual([]);
});
