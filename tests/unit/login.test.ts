import { beforeEach, describe, expect, it } from "vitest";
import { call, h, makeUser, resetHarness, settle } from "./harness";

const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");

const signIn = (identifier: string, password: string) =>
  call(login, "/api/auth/login", { body: { identifier, password, timeZone: "America/New_York" } });

beforeEach(() => resetHarness());

describe("PORTAL-STANDARD §2: exact sign-in errors", () => {
  it("no_account names what was typed, under the identifier field", async () => {
    const r = await signIn("nobody", "whatever-password");
    expect(r.status).toBe(401);
    expect(r.data).toMatchObject({ ok: false, code: "no_account", field: "identifier", error: 'No account exists with the username or email "nobody".' });
  });

  it("wrong_password names the account and counts the attempts left", async () => {
    const u = await makeUser({ username: "miriam" });
    const r = await signIn("miriam", "not-the-password");
    expect(r.data).toMatchObject({ code: "wrong_password", field: "password" });
    expect(r.data.error).toBe(
      "Incorrect password for miriam. 9 attempts left before the account locks. 4 more wrong passwords from IP 203.0.113.10 will block that address.",
    );
    // Email works the same as the username, and the count is per account.
    const r2 = await signIn(`${u.username}@example.com`, "still-wrong");
    expect(r2.data.error).toMatch(/^Incorrect password for miriam\. 8 attempts left/);
  });

  it("warns when the IP threshold will block before the account locks", async () => {
    await makeUser({ username: "dina" });
    for (let i = 0; i < 2; i++) await signIn("dina", "nope");
    const r = await signIn("dina", "nope");
    // 3 wrong from this IP, auto-block at 5: 2 more.
    expect(r.data.error).toContain("2 more wrong passwords from IP 203.0.113.10 will block that address.");
  });

  it("account_locked after 10 wrong passwords, with the time it unlocks", async () => {
    await makeUser({ username: "leah" });
    // Spread over addresses so the per-IP auto-block (5) doesn't fire first.
    for (let i = 0; i < 10; i++) {
      h.ip = `198.51.100.${i + 1}`;
      await signIn("leah", "wrong");
    }
    h.ip = "198.51.100.50";
    const r = await signIn("leah", "Correct-Horse-Battery-Staple-9!");
    expect(r.status).toBe(429);
    expect(r.data.code).toBe("account_locked");
    expect(r.data.error).toMatch(/^This account is locked until \d{1,2}:\d{2} (AM|PM) E[SD]T after 10 wrong passwords\.$/);
  });

  it("account_suspended states the recorded reason", async () => {
    const u = await makeUser({ username: "rivka" });
    h.d1.exec("UPDATE users SET suspended_at = 1, suspended_reason = 'Spam' WHERE id = ?", u.id);
    const r = await signIn("rivka", u.password);
    expect(r.data).toMatchObject({ code: "account_suspended", error: "This account is suspended by an administrator. Reason: Spam" });
  });

  it("an administrator's lock is stated as such", async () => {
    const u = await makeUser({ username: "sara" });
    h.d1.exec("UPDATE users SET locked_until = ?, locked_reason = 'Investigating' WHERE id = ?", 8.64e15, u.id);
    const r = await signIn("sara", u.password);
    expect(r.data).toMatchObject({ code: "account_locked" });
    expect(r.data.error).toBe("This account is locked by an administrator until an administrator unlocks it. Reason: Investigating");
  });

  it("ip_blocked states the address and reason", async () => {
    await makeUser({ username: "tova" });
    h.d1.exec("INSERT INTO ip_rules (kind, ip, source, reason, created_at) VALUES ('deny', '203.0.113.10', 'manual', 'abuse', 1)");
    const r = await signIn("tova", "x");
    expect(r.data).toMatchObject({ code: "ip_blocked", error: "Your IP 203.0.113.10 is blocked (reason: abuse)." });
  });

  it("ip_not_allowed when the allowlist is enforced", async () => {
    const u = await makeUser({ username: "yael", role: "admin" });
    h.d1.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('allowlist_mode', '"admins"', 1)`);
    const r = await signIn("yael", u.password);
    expect(r.data).toMatchObject({ code: "ip_not_allowed", error: expect.stringContaining("Your IP 203.0.113.10 is not on this portal's allowlist") });
    h.d1.exec("INSERT INTO ip_rules (kind, ip, created_at) VALUES ('allow', '203.0.113.0/24', 1)");
    const ok = await signIn("yael", u.password);
    expect(ok.data).toMatchObject({ ok: true, next: "/login/verify" });
  });

  it("rate_limited states the address and the wait", async () => {
    for (let i = 0; i < 30; i++) h.d1.exec("INSERT INTO rate_limits (key, count, reset_at) VALUES ('login:ip:203.0.113.10', 30, ?) ON CONFLICT(key) DO NOTHING", Date.now() + 252_000);
    const r = await signIn("x", "y");
    expect(r.status).toBe(429);
    expect(r.data.code).toBe("rate_limited");
    expect(r.data.error).toMatch(/^Too many sign-in attempts from 203\.0\.113\.10\. Try again in 4 min \d+ s\.$/);
  });

  it("must_change_password is said after the password and routes on", async () => {
    const u = await makeUser({ username: "chana" });
    h.d1.exec("UPDATE users SET must_change_password = 1 WHERE id = ?", u.id);
    const r = await signIn("chana", u.password);
    expect(r.data).toMatchObject({ ok: true, code: "must_change_password", next: "/login/verify" });
  });

  it("forgot password says exactly whether the account exists (no enumeration policy)", async () => {
    await makeUser({ username: "bracha" });
    const none = await call(forgot, "/api/auth/forgot-password", { body: { identifier: "ghost" } });
    expect(none.data).toMatchObject({ code: "no_account", field: "identifier" });
    const ok = await call(forgot, "/api/auth/forgot-password", { body: { identifier: "bracha" } });
    expect(ok.data.message).toMatch(/^We emailed a reset link for bracha to br•••@example\.com\./);
    await settle();
  });
});

describe("PORTAL-STANDARD §7: auto-blacklist from sign-in failures", () => {
  it("5 wrong passwords from one IP blocks it, kills its sessions, audits and alerts", async () => {
    const victim = await makeUser({ username: "target" });
    // An allowlisted address is not exempt.
    h.d1.exec("INSERT INTO ip_rules (kind, ip, label, created_at) VALUES ('allow', '203.0.113.10', 'office', 1)");
    h.d1.exec(
      "INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at, ip) VALUES ('s1', ?, 'full', 1, ?, ?, '203.0.113.10')",
      victim.id,
      Date.now(),
      Date.now() + 1e7,
    );
    let last;
    for (let i = 0; i < 5; i++) last = await signIn("target", "wrong");
    expect(last!.data.code).toBe("ip_blocked");
    expect(last!.data.error).toContain("Your IP 203.0.113.10 is now blocked (reason: 5 wrong passwords in 15 min.)");

    const deny = h.d1.one<{ source: string; trigger_kind: string; was_allowlisted: number; sessions_killed: number; evidence: string }>(
      "SELECT * FROM ip_rules WHERE kind = 'deny'",
    )!;
    expect(deny).toMatchObject({ source: "auto", trigger_kind: "failed_logins", was_allowlisted: 1, sessions_killed: 1 });
    expect(JSON.parse(deny.evidence)).toContain("5 wrong passwords");
    expect(h.d1.one("SELECT revoked_at FROM ip_rules WHERE kind = 'allow'")!.revoked_at).not.toBeNull();
    expect(h.d1.rows("SELECT * FROM sessions WHERE ip = '203.0.113.10'")).toHaveLength(0);
    expect(h.d1.one("SELECT COUNT(*) AS n FROM events WHERE type = 'security.auto_blocked'")!.n).toBe(1);
    await settle();
    expect(h.d1.rows("SELECT event FROM security_alerts WHERE event = 'auto_blacklist'")).toHaveLength(1);

    // Next request: refused outright.
    const after = await signIn("target", "anything");
    expect(after.data.code).toBe("ip_blocked");
  });

  it("failed attempts against 3 different accounts in the window blocks", async () => {
    await makeUser({ username: "a1" });
    await makeUser({ username: "a2" });
    await signIn("a1", "x");
    await signIn("a2", "x");
    const r = await signIn("someone-else", "x");
    expect(r.data.code).toBe("no_account");
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("multi_account");
  });

  it("an injection signature in the identifier blocks at once", async () => {
    const r = await signIn("admin' OR 1=1 --", "x");
    expect(r.data.code).toBe("injection");
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("injection");
  });

  it("is off when the setting is off (still audited)", async () => {
    h.d1.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('auto_block_enabled', 'false', 1)`);
    await makeUser({ username: "z" });
    for (let i = 0; i < 6; i++) await signIn("z", "x");
    expect(h.d1.rows("SELECT * FROM ip_rules WHERE kind = 'deny'")).toHaveLength(0);
  });

  it("never blocks the local machine (development and tests)", async () => {
    h.ip = "127.0.0.1";
    await makeUser({ username: "local" });
    for (let i = 0; i < 6; i++) await signIn("local", "x");
    expect(h.d1.rows("SELECT * FROM ip_rules WHERE kind = 'deny'")).toHaveLength(0);
    expect(h.d1.one("SELECT COUNT(*) AS n FROM events WHERE type = 'security.auto_block_skipped'")!.n).toBeGreaterThan(0);
  });
});
