/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are read loosely in these tests */
import { beforeEach, describe, expect, it } from "vitest";
import { call, h, makeUser, resetHarness, settle, signInAs } from "./harness";

const route = await import("@/app/api/console/[...path]/route");

function c(method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-requested-with": "console" }) {
  const [p] = path.split("?");
  return call(route[method as "GET"] as never, `/api/console/${path}`, {
    method,
    body,
    headers,
    ctx: { params: Promise.resolve({ path: p.split("/") }) } as never,
  });
}

let owner: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let member: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  resetHarness();
  owner = await makeUser({ username: "owner", role: "owner" });
  admin = await makeUser({ username: "admin", role: "admin" });
  member = await makeUser({ username: "member" });
});

describe("console API: transport and auth", () => {
  it("401 unauthenticated without a session", async () => {
    expect((await c("GET", "bootstrap")).data).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("non-admins get a 404 and it counts as an admin-denied strike", async () => {
    await signInAs(member.id);
    const r = await c("GET", "bootstrap");
    expect(r.status).toBe(404);
    expect(h.d1.one<{ kind: string }>("SELECT kind FROM ip_strikes")?.kind).toBe("admin_denied");
    await c("GET", "people");
    await c("GET", "people");
    // 3 in 15 minutes: auto-blacklisted.
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("admin_denied");
  });

  it("rejects writes without X-Requested-With or from another origin (csrf)", async () => {
    await signInAs(owner.id);
    expect((await c("PATCH", "settings", { values: {} }, {})).data.code).toBe("csrf");
    expect((await c("PATCH", "settings", { values: {} }, { "x-requested-with": "console", origin: "https://evil.example" })).data.code).toBe("csrf");
  });

  it("writes need a fresh second factor (step_up_required with a reverify URL)", async () => {
    await signInAs(owner.id, { verified: false });
    const r = await c("POST", `people/${member.id}/lock`, {});
    expect(r.status).toBe(403);
    expect(r.data).toMatchObject({ code: "step_up_required", reverify_url: "/admin/verify?next=/admin" });
    // Reads don't.
    expect((await c("GET", "people")).data.ok).toBe(true);
  });

  it("bootstrap sets features honestly and resolves perms", async () => {
    await signInAs(owner.id);
    const b = (await c("GET", "bootstrap")).data;
    expect(b).toMatchObject({ ok: true, api: 1, is_owner: true, your_ip: "203.0.113.10", site: { timezone: "America/New_York" } });
    const f = b.features as Record<string, boolean>;
    expect(f.invitations).toBe(false);
    expect(f.devices).toBe(false);
    expect(f.mfa_email_toggle).toBe(false);
    expect(f.deny_auto && f.streak_restores && f.alerts && f.people_lock).toBe(true);
    expect(b.perms).toEqual(expect.arrayContaining(["ips.manage", "settings.manage", "streaks.manage", "audit.revert"]));
    expect((b.links as { href: string }[]).map((l) => l.href)).toContain("/admin/visitors");

    h.cookies.clear();
    await signInAs(admin.id);
    const a = (await c("GET", "bootstrap")).data;
    expect(a.is_owner).toBe(false);
    expect(a.perms).not.toContain("ips.manage");
    expect(a.perms).not.toContain("streaks.manage");
  });
});

describe("console API: people", () => {
  it("lists people with MFA kinds in canonical order", async () => {
    await signInAs(owner.id);
    const r = (await c("GET", "people?q=member")).data;
    expect(r.total).toBe(1);
    const p = (r.items as Record<string, unknown>[])[0];
    expect(p).toMatchObject({ username: "member", status: "active", mfa: ["passkey", "totp", "recovery"] });
  });

  it("the record lists MFA methods passkey, totp, then recovery, and explains refused actions", async () => {
    await signInAs(admin.id);
    const r = (await c("GET", `people/${owner.id}`)).data as Record<string, any>;
    expect(r.mfa.methods.map((m: { kind: string }) => m.kind)).toEqual(["passkey", "totp", "recovery"]);
    expect(r.actions.suspend).toEqual({ allowed: false, reason: "Nobody can change the owner's account from the console." });
    const self = (await c("GET", `people/${admin.id}`)).data as Record<string, any>;
    expect(self.actions.delete).toEqual({ allowed: false, reason: "You can't delete your own account." });
    expect(self.actions.streak_set.allowed).toBe(false);
  });

  it("suspend / activate, lock / unlock, with audit entries", async () => {
    await signInAs(admin.id);
    expect((await c("POST", `people/${member.id}/status`, { status: "suspended", reason: "Spam" })).data).toMatchObject({ ok: true, status: "suspended" });
    expect((await c("GET", `people/${member.id}`)).data).toMatchObject({ person: { status: "suspended", status_reason: "Spam" } });
    expect((await c("POST", `people/${member.id}/status`, { status: "active" })).data.ok).toBe(true);
    expect((await c("POST", `people/${member.id}/lock`, { minutes: 30, reason: "Check" })).data.locked_until).toBeTruthy();
    expect((await c("GET", `people/${member.id}`)).data).toMatchObject({ person: { status: "locked" } });
    expect((await c("POST", `people/${member.id}/unlock`, {})).data.ok).toBe(true);
    const types = h.d1.rows<{ type: string }>("SELECT type FROM events WHERE type LIKE 'admin.%' ORDER BY id").map((r) => r.type);
    expect(types).toEqual(["admin.suspend", "admin.unsuspend", "admin.lock", "admin.unlock"]);
  });

  it("an admin can't act on another admin; the owner can't be suspended", async () => {
    await signInAs(admin.id);
    const other = await makeUser({ username: "admin2", role: "admin" });
    expect((await c("POST", `people/${other.id}/status`, { status: "suspended" })).data).toMatchObject({ code: "forbidden", error: "Only the owner can change admin accounts." });
    h.cookies.clear();
    await signInAs(owner.id);
    expect((await c("POST", `people/${owner.id}/status`, { status: "suspended" })).data.code).toBe("last_owner");
  });

  it("validation errors name the field", async () => {
    await signInAs(owner.id);
    await makeUser({ username: "dovid" });
    const r = await c("PATCH", `people/${member.id}`, { username: "dovid" });
    expect(r.data).toMatchObject({ code: "validation", field: "username", error: 'The username "dovid" is taken by another account.' });
    expect((await c("PATCH", `people/${member.id}`, { first_name: "Miri", notes: "VIP" })).data).toMatchObject({ ok: true, person: { name: expect.stringMatching(/^Miri Tester/) } });
  });

  it("creates a person with a temporary password shown once", async () => {
    await signInAs(owner.id);
    const r = await c("POST", "people", { name: "Chana Levi", username: "chana", email: "chana@example.com", phone: "+12125550188", role: "member" });
    expect(r.status).toBe(201);
    expect(typeof r.data.temporary_password).toBe("string");
    expect(r.data.person).toMatchObject({ username: "chana", flags: expect.arrayContaining(["must_change_password", "mfa_missing"]) });
  });
});

describe("console API: IP lists and auto-blacklist (§7)", () => {
  it("refuses to block your own address (self_lockout)", async () => {
    await signInAs(owner.id);
    expect((await c("POST", "deny", { ip_or_cidr: "203.0.113.0/24" })).data).toMatchObject({ code: "self_lockout" });
    expect((await c("POST", "deny", { ip_or_cidr: "0.0.0.0/0" })).data).toMatchObject({ code: "validation", field: "ip_or_cidr" });
  });

  it("shows auto entries with evidence; Unblock can re-add to the allowlist", async () => {
    await signInAs(owner.id);
    const add = await c("POST", "ips", { ip_or_cidr: "198.51.100.7", label: "home" });
    expect(add.data).toMatchObject({ ok: true, item: { status: "active" } });
    const { autoBlock } = await import("@/server/threat");
    const { resolveSettings } = await import("@/lib/settings-schema");
    await autoBlock("198.51.100.7", "decoy", "Requested a scanner/decoy path.", ["GET /.env"], resolveSettings({}));
    const deny = (await c("GET", "deny")).data as Record<string, any>;
    expect(deny.items[0]).toMatchObject({ source: "auto", trigger: "decoy", evidence: ["GET /.env"], was_allowlisted: true, created_by: null, expires_at: null });
    const allow = (await c("GET", "ips")).data as Record<string, any>;
    expect(allow.items[0]).toMatchObject({ status: "revoked", revoked_reason: "Auto-blacklisted: Requested a scanner/decoy path." });
    const un = await c("POST", `deny/${deny.items[0].id}/unblock`, { readd_allowlist: true });
    expect(un.data).toMatchObject({ ok: true, readded: true });
    expect(((await c("GET", "deny")).data.items as unknown[]).length).toBe(0);
    expect(((await c("GET", "ips")).data.items as { status: string }[]).filter((i) => i.status === "active")).toHaveLength(1);
    await settle();
    expect(h.d1.rows<{ event: string }>("SELECT event FROM security_alerts").map((r) => r.event)).toEqual(
      expect.arrayContaining(["ip_list_changed", "auto_blacklist"]),
    );
  });

  it("an admin (not owner) can view but not change the lists", async () => {
    await signInAs(admin.id);
    expect((await c("GET", "deny")).data.can_manage).toBe(false);
    expect((await c("POST", "deny", { ip_or_cidr: "198.51.100.9" })).data).toMatchObject({ code: "forbidden", perm: "ips.manage" });
  });

  it("removing the allowlist entry that covers you is refused while the allowlist is enforced", async () => {
    await signInAs(owner.id);
    const add = await c("POST", "ips", { ip_or_cidr: "203.0.113.10" });
    await c("PATCH", "settings", { values: { allowlist_mode: "admins" } });
    expect((await c("DELETE", `ips/${(add.data.item as { id: string }).id}`)).data.code).toBe("self_lockout");
  });
});

describe("console API: settings, audit, alerts", () => {
  it("settings: validation with fields, change audited and alerted", async () => {
    await signInAs(owner.id);
    const s = (await c("GET", "settings")).data as Record<string, any>;
    expect(s.items.find((i: { key: string }) => i.key === "streak_restores")).toMatchObject({ value: 3, default: 3, min: 0, max: 31 });
    expect(s.items.find((i: { key: string }) => i.key === "alerts_to")).toMatchObject({ type: "readonly", value: "soc@onlyjewishgirls.com (default)" });
    const bad = await c("PATCH", "settings", { values: { streak_restores: 99 } });
    expect(bad.data).toMatchObject({ code: "validation", field: "streak_restores", fields: { streak_restores: "Courtesy restores per month must be at most 31." } });
    const ok = await c("PATCH", "settings", { values: { streak_restores: 5 } });
    expect(ok.data).toMatchObject({ ok: true, changed: ["streak_restores"] });
    await settle();
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'settings_changed'")).toHaveLength(1);
    h.cookies.clear();
    await signInAs(admin.id);
    expect((await c("PATCH", "settings", { values: { streak_restores: 1 } })).data.code).toBe("forbidden");
  });

  it("audit entries link to the alert they emailed; alerts show routing", async () => {
    await signInAs(owner.id);
    await c("POST", `people/${member.id}/status`, { status: "suspended" });
    await settle();
    const audit = (await c("GET", "audit?category=people")).data as Record<string, any>;
    const entry = audit.items.find((i: { action: string }) => i.action === "admin.suspend");
    expect(entry).toMatchObject({ category: "people", actor: { name: "owner" }, target: { label: "member" }, revertible: true });
    expect(entry.alert_id).toBeTruthy();
    const alerts = (await c("GET", "alerts")).data as Record<string, any>;
    expect(alerts.routing).toMatchObject({ from: "securityalerts@onlyjewishgirls.com", to: "soc@onlyjewishgirls.com" });
    expect(alerts.items[0]).toMatchObject({ subject: "[OnlyJewishGirls] Account status changed on the member site", audit_id: entry.id });
    // Deep link from the alert email, and the person filter (actor or target).
    expect((await c("GET", `audit/${entry.id}`)).data).toMatchObject({ ok: true, entry: { id: entry.id, alert_id: entry.alert_id } });
    const byPerson = (await c("GET", `audit?person=${member.id}`)).data as Record<string, any>;
    expect(byPerson.items.every((i: any) => i.target?.id === String(member.id) || i.actor?.id === String(member.id))).toBe(true);
    expect((await c("GET", "audit/verify")).data.code).toBe("not_found");
    // Revert
    expect((await c("POST", `audit/${entry.id}/revert`, {})).data.ok).toBe(true);
  });

  it("overview, streaks, roles, sessions and visitors answer", async () => {
    await signInAs(owner.id);
    for (const p of ["overview", "streaks", "roles", "sessions", "security/visitors", "streaks/restores", "events"]) {
      const r = await c("GET", p);
      expect(r.data.ok, p).toBe(true);
    }
    expect(((await c("GET", "sessions")).data.items as unknown[]).length).toBe(1);
    expect((await c("GET", "bootstrap")).data.counts).toEqual({ deny: 0 });
    h.d1.exec("INSERT INTO ip_strikes (ip, kind, subject, at) VALUES ('198.51.100.3', 'decoy', '/.env', ?)", Date.now());
    h.d1.exec("INSERT INTO ip_rules (kind, ip, source, reason, created_at) VALUES ('deny', '198.51.100.3', 'auto', 'decoy', ?)", Date.now());
    const v = (await c("GET", "security/visitors?band=hostile")).data as Record<string, any>;
    expect(v.items[0]).toMatchObject({ ip: "198.51.100.3", band: "hostile", denied: true, deny_id: expect.any(String), probe_hits: 1 });
    expect((await c("GET", "people/schema")).data.create_fields).toBeTruthy();
    expect((await c("GET", "nope")).data).toMatchObject({ code: "not_found" });
  });
});

describe("console API: export audit (PORTAL-STANDARD §11)", () => {
  it("bootstrap turns export_audit on", async () => {
    await signInAs(admin.id);
    expect(((await c("GET", "bootstrap")).data as Record<string, any>).features.export_audit).toBe(true);
  });

  it("records one `export` audit entry, with no security alert", async () => {
    await signInAs(admin.id);
    const r = await c("POST", "exports", { section: "people", title: "People — member — Profile", format: "pdf", rows: 17 });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true });
    await settle();
    const rows = h.d1.rows<{ type: string; actor_username: string; user_id: number | null; detail: string; ip: string }>(
      "SELECT type, actor_username, user_id, detail, ip FROM events WHERE type = 'export'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_username: "admin", user_id: null });
    expect(JSON.parse(rows[0].detail)).toEqual({ section: "people", title: "People — member — Profile", format: "pdf", rows: 17 });
    expect(h.d1.rows("SELECT * FROM security_alerts")).toHaveLength(0);

    const audit = (await c("GET", "audit?category=audit")).data as Record<string, any>;
    expect(audit.items[0]).toMatchObject({
      action: "export",
      category: "audit",
      severity: "info",
      outcome: "success",
      detail: "Exported People — member — Profile as PDF (17 rows)",
      actor: { name: "admin" },
      target: null,
      revertible: false,
    });
    // Not filed under People.
    const people = (await c("GET", "audit?category=people")).data as Record<string, any>;
    expect(people.items.some((i: { action: string }) => i.action === "export")).toBe(false);
  });

  it("works without a fresh second factor (it only reads) and without a title (export.js pages)", async () => {
    await signInAs(admin.id, { verified: false });
    expect((await c("POST", "exports", { section: "Accounts", format: "csv", rows: 1 })).data).toEqual({ ok: true });
    const audit = (await c("GET", "audit?action=export")).data as Record<string, any>;
    expect(audit.items[0].detail).toBe("Exported Accounts as CSV (1 row)");
  });

  it("needs a signed-in admin and the console CSRF header", async () => {
    const body = { section: "people", format: "csv", rows: 1 };
    expect((await c("POST", "exports", body)).data.code).toBe("unauthenticated");
    await signInAs(member.id);
    expect((await c("POST", "exports", body)).status).toBe(404);
    h.cookies.clear();
    await signInAs(admin.id);
    expect((await c("POST", "exports", body, {})).data.code).toBe("csrf");
    expect((await c("POST", "exports", body, { "x-requested-with": "console", origin: "https://evil.example" })).data.code).toBe("csrf");
    expect(h.d1.rows("SELECT * FROM events WHERE type = 'export'")).toHaveLength(0);
  });

  it("validates and caps every field", async () => {
    await signInAs(admin.id);
    const bad = async (body: unknown) => (await c("POST", "exports", body)).data;
    expect(await bad({ format: "csv", rows: 1 })).toMatchObject({ code: "validation", field: "section" });
    expect(await bad({ section: "  \u0000 ", format: "csv", rows: 1 })).toMatchObject({ code: "validation", field: "section" });
    expect(await bad({ section: "x".repeat(121), format: "csv", rows: 1 })).toMatchObject({ code: "validation", field: "section" });
    expect(await bad({ section: "people", title: "t".repeat(301), format: "csv", rows: 1 })).toMatchObject({ field: "title" });
    expect(await bad({ section: "people", title: 5, format: "csv", rows: 1 })).toMatchObject({ field: "title" });
    expect(await bad({ section: "people", format: "xlsx", rows: 1 })).toMatchObject({ code: "validation", field: "format" });
    expect(await bad({ section: "people", format: "csv", rows: -1 })).toMatchObject({ field: "rows" });
    expect(await bad({ section: "people", format: "csv", rows: 1.5 })).toMatchObject({ field: "rows" });
    expect(await bad({ section: "people", format: "csv", rows: "9" })).toMatchObject({ field: "rows" });
    expect(h.d1.rows("SELECT * FROM events WHERE type = 'export'")).toHaveLength(0);
    // Control characters are flattened before they reach the log.
    expect((await bad({ section: "peo\nple", title: "A\u0007B\r\nC", format: "HTML", rows: 0 })).ok).toBe(true);
    expect(JSON.parse(h.d1.one<{ detail: string }>("SELECT detail FROM events WHERE type = 'export'")!.detail)).toEqual({
      section: "peo ple",
      title: "A B C",
      format: "html",
      rows: 0,
    });
  });
});
