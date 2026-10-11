import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { addVirtualAuthenticator, collectConsoleErrors, completeMfaSetup, query, screenshot, signIn, sql } from "./helpers";

const ORIGIN = "http://localhost:3100";

const owner = {
  firstName: "Batsheva",
  lastName: "Rosen",
  email: "owner@example.com",
  username: "owner_bs",
  phone: "212-555-0181",
  password: "Gk4!Xw#Tq7Vz$Mp9",
};

const member = {
  firstName: "Miriam",
  lastName: "Katz",
  email: "miriam@example.com",
  username: "miriam_k",
  phone: "212-555-0173",
  newPassword: "Tz8#Qv!Hn4Wk$Ry6",
  secondPassword: "Jx5$Pw!Gd3Nq#Hv8",
};

async function registerOwner(page: Page) {
  await page.goto("/register");
  await page.getByLabel("First name").fill(owner.firstName);
  await page.getByLabel("No middle name").check();
  await page.getByLabel("Last name").fill(owner.lastName);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Username").fill(owner.username);
  await page.locator("#phone").fill(owner.phone);
  await page.locator("#password").fill(owner.password);
  await page.locator("#confirmPassword").fill(owner.password);
  await expect(page.locator('[data-rule="dictionary"]')).toHaveAttribute("data-state", "ok");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/setup-mfa");
  await completeMfaSetup(page);
  await expect(page).toHaveURL("/home");
}

/** Clicks an action on the account page and confirms it if asked. */
async function runAction(page: Page, action: string, confirmLabel?: string, input?: string) {
  await page.locator(`[data-action="${action}"]`).first().click();
  if (confirmLabel) {
    const dialog = page.getByRole("dialog");
    if (input !== undefined) await dialog.locator("input, textarea").first().fill(input);
    await dialog.getByRole("button", { name: confirmLabel }).click();
  }
}

const toast = (page: Page) => page.getByTestId("toast");

test.describe.configure({ mode: "serial" });

test("owner monitors and controls accounts from the admin panel", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const ownerErrors = collectConsoleErrors(page);
  await addVirtualAuthenticator(page);

  const memberContext = await browser.newContext({ baseURL: ORIGIN, timezoneId: "America/New_York" });
  const m = await memberContext.newPage();
  const memberErrors = collectConsoleErrors(m);
  await addVirtualAuthenticator(m);

  let memberId = 0;
  let temporaryPassword = "";

  await test.step("the owner account gets the admin panel", async () => {
    await registerOwner(page);
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
    sql(`UPDATE users SET role = 'owner' WHERE username = '${owner.username}'`);
    await page.reload();
    await page.getByRole("link", { name: "Admin" }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText("Emails aren't set up")).toBeVisible();
    await expect(page.getByText("New accounts per day")).toBeVisible();
    await screenshot(page, "admin-1-overview");
  });

  await test.step("create an account with a temporary password", async () => {
    await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "+ New account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("First name").fill(member.firstName);
    await dialog.getByLabel("Last name").fill(member.lastName);
    await dialog.getByLabel("Email").fill(member.email);
    await dialog.getByLabel("Username").fill(member.username);
    await dialog.getByLabel("Mobile number").fill(member.phone);
    await dialog.getByRole("button", { name: "Create account" }).click();
    temporaryPassword = (await dialog.getByTestId("temporary-password").innerText()).trim();
    expect(temporaryPassword).toHaveLength(20);
    await screenshot(page, "admin-2-created");
    await dialog.getByRole("button", { name: "Done" }).click();
    memberId = query<{ id: number }>(`SELECT id FROM users WHERE username = '${member.username}'`)[0].id;
  });

  await test.step("the new member signs in, sets up two-step sign-in, then must choose a password", async () => {
    await signIn(m, member.username, temporaryPassword);
    await expect(m).toHaveURL("/setup-mfa");
    await completeMfaSetup(m);
    await expect(m).toHaveURL("/change-password");
    await expect(m.getByRole("heading", { name: "Choose your own password" })).toBeVisible();
    await m.goto("/home");
    await expect(m).toHaveURL("/change-password");
    await m.locator("#password").fill(member.newPassword);
    await m.locator("#confirmPassword").fill(member.newPassword);
    await expect(m.locator('[data-rule="personal"]')).toHaveAttribute("data-state", "ok");
    await m.getByRole("button", { name: "Save new password" }).click();
    await expect(m).toHaveURL("/home");
  });

  await test.step("members can't see the admin panel or use its API", async () => {
    await expect(m.getByRole("link", { name: "Admin" })).toHaveCount(0);
    const res = await m.goto("/admin");
    expect(res?.status()).toBe(404);
    const api = await memberContext.request.post("/api/admin/action", {
      headers: { Origin: ORIGIN },
      data: { userId: memberId, action: "set_role", role: "admin" },
    });
    expect(api.status()).toBe(404);
  });

  await test.step("search finds the account and its live session", async () => {
    await page.goto("/admin/users");
    await page.getByRole("searchbox").fill("miri");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("account-list").locator("li")).toHaveCount(1);
    await page.getByTestId("account-list").getByText(member.username).click();
    await expect(page.getByTestId("account-username")).toHaveText(member.username);
    await expect(page.getByTestId("session-list").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("session-list")).toContainText(/Chrome on (Windows|Linux|Mac)/);
  });

  await test.step("changes need a fresh second factor; suspending signs them out", async () => {
    // Pretend the owner's last second-factor check (and their passkey) are from hours ago.
    const ownerRow = `(SELECT id FROM users WHERE username = '${owner.username}')`;
    sql(`UPDATE passkeys SET created_at = created_at - 7200000 WHERE user_id = ${ownerRow}`);
    sql(`UPDATE sessions SET verified_at = verified_at - 3600000 WHERE user_id = ${ownerRow}`);
    // A stale session can't attach a new passkey (and so can't use one to pass the check).
    const enroll = await page.request.post("/api/mfa/passkey/register/options", { headers: { Origin: ORIGIN } });
    expect(enroll.status()).toBe(403);

    await runAction(page, "suspend", "Suspend account", "Testing the panel");
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toBeVisible();
    await page.getByRole("button", { name: /Use my passkey/ }).click();
    await expect(toast(page)).toContainText("is suspended");
    await expect(page.getByText("Reason: Testing the panel").first()).toBeVisible();
    await screenshot(page, "admin-3-suspended");

    await m.reload();
    await expect(m).toHaveURL("/login");
    await signIn(m, member.username, member.newPassword);
    await expect(m.getByText("This account has been suspended")).toBeVisible();
  });

  await test.step("a password typed as a username is never logged", async () => {
    await signIn(m, "Wq3#Lp!Zn8Vb$Kd5", "anything");
    await expect(m.getByText("Incorrect username/email or password.")).toBeVisible();
    await page.goto("/admin/activity?group=signin");
    await expect(page.locator('[data-event="signin.unknown"]').first()).toBeVisible();
    await expect(page.getByText(/wq3#lp/i)).toHaveCount(0);
  });

  await test.step("the owner can undo it from the activity log", async () => {
    await page.goto("/admin/activity?group=admin");
    const entry = page.locator('[data-event="admin.suspend"]').first();
    await expect(entry).toContainText(member.username);
    await entry.getByRole("button", { name: /Undo/ }).click();
    await expect(toast(page)).toContainText("Change undone.");
    await expect(page.locator('[data-event="admin.suspend"]').first()).toContainText("Undone by");
    await screenshot(page, "admin-4-activity");

    await signIn(m, member.username, member.newPassword);
    await m.getByRole("button", { name: /Use my passkey/ }).click();
    await expect(m).toHaveURL("/home");
  });

  await test.step("edit the profile, streak and note", async () => {
    await page.goto(`/admin/users/${memberId}`);
    await page.getByText("Edit profile").click();
    const form = page.locator("details");
    await form.getByLabel("First name").fill("Miri");
    await form.getByRole("button", { name: "Save profile" }).click();
    await expect(toast(page)).toContainText("Profile saved.");
    await expect(page.getByText("Miri Katz")).toBeVisible();

    await page.getByLabel("Set streak to").fill("7");
    await page.getByRole("button", { name: "Set", exact: true }).click();
    await expect(toast(page)).toContainText("Streak set to 7");
    await m.goto("/home");
    await expect(m.getByTestId("streak-count")).toHaveText("7");

    await page.getByLabel(/Admin note/).fill("Met at the Shabbaton");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(toast(page)).toContainText("Note saved.");
    await expect(page.locator("p").filter({ hasText: "Met at the Shabbaton" }).first()).toBeVisible();
  });

  await test.step("an admin can manage members but not the owner", async () => {
    await page.getByLabel("Role", { exact: true }).selectOption("admin");
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await expect(toast(page)).toContainText("is now an Admin");

    await m.reload();
    await m.getByRole("link", { name: "Admin" }).click();
    await expect(m.getByRole("heading", { name: "Overview" })).toBeVisible();
    const ownerId = query<{ id: number }>(`SELECT id FROM users WHERE username = '${owner.username}'`)[0].id;
    await m.goto(`/admin/users/${ownerId}`);
    await expect(m.getByTestId("account-username")).toHaveText(owner.username);
    await expect(m.getByRole("region", { name: "Actions" })).toHaveCount(0);
    const api = await memberContext.request.post("/api/admin/action", {
      headers: { Origin: ORIGIN },
      data: { userId: ownerId, action: "suspend" },
    });
    expect(api.status()).toBe(403);

    await page.getByLabel("Role", { exact: true }).selectOption("member");
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await expect(toast(page)).toContainText("is now a Member");
    expect((await m.goto("/admin"))?.status()).toBe(404);
  });

  await test.step("a temporary password signs them out and must be replaced", async () => {
    await m.goto("/home");
    await runAction(page, "set_temp_password", "Set temporary password");
    const password = (await page.getByTestId("temporary-password").innerText()).trim();
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

    await m.reload();
    await expect(m).toHaveURL("/login");
    await signIn(m, member.username, member.newPassword);
    await expect(m.getByText("Incorrect username/email or password.")).toBeVisible();
    await signIn(m, member.username, password);
    await m.getByRole("button", { name: /Use my passkey/ }).click();
    await expect(m).toHaveURL("/change-password");
    await m.locator("#password").fill(member.secondPassword);
    await m.locator("#confirmPassword").fill(member.secondPassword);
    await m.getByRole("button", { name: "Save new password" }).click();
    await expect(m).toHaveURL("/home");
  });

  await test.step("sign one device out remotely", async () => {
    await page.reload();
    await page.getByTestId("session-list").locator('[data-action="revoke_session"]').first().click();
    await expect(toast(page)).toContainText("That device is signed out.");
    await m.reload();
    await expect(m).toHaveURL("/login");
  });

  await test.step("reset two-step sign-in sends them back to setup", async () => {
    await runAction(page, "reset_two_step", "Reset two-step sign-in");
    await expect(toast(page)).toContainText("Two-step sign-in reset");
    await expect(page.getByText("Passkeys (0)")).toBeVisible();
    await signIn(m, member.username, member.secondPassword);
    await expect(m).toHaveURL("/setup-mfa");
  });

  await test.step("export every account as CSV", async () => {
    await page.goto("/admin/users");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^onlyjewishgirls-accounts-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync((await download.path())!, "utf8");
    expect(csv.split("\r\n")[0]).toContain("id,username,first_name");
    expect(csv).toContain(member.username);
  });

  await test.step("delete the account; the log keeps its name", async () => {
    await page.goto(`/admin/users/${memberId}`);
    await runAction(page, "delete", "Delete forever", member.username);
    await expect(page).toHaveURL("/admin/users");
    await expect(page.getByTestId("account-list")).not.toContainText(member.username);
    await page.goto("/admin/activity");
    await expect(page.getByText(`${member.username} (deleted)`).first()).toBeVisible();
    expect(query(`SELECT 1 FROM passkeys WHERE user_id = ${memberId}`)).toHaveLength(0);
  });

  await test.step("the overview counts it all", async () => {
    await page.goto("/admin");
    await expect(page.getByText("Signed in now")).toBeVisible();
    await page.setViewportSize({ width: 412, height: 915 });
    await screenshot(page, "admin-5-overview-phone");
    await page.goto(`/admin/users`);
    await screenshot(page, "admin-6-accounts-phone");
  });

  expect(ownerErrors).toEqual([]);
  expect(memberErrors).toEqual([]);
  await memberContext.close();
});
