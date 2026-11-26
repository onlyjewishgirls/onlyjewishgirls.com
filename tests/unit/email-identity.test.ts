/**
 * Every email reads as a legitimate notice from the business (PORTAL-STANDARD §6, after Plunk's review):
 * the business in the sender and subject, who we are and why the recipient gets it, the facts, what to
 * do, the footer, links only to the site's own domain with the URL as the visible text, and HTML that
 * still reads correctly once Plunk turns it into the plain-text part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, h, makeUser, resetHarness, settle, signInAs } from "./harness";

const { recordAndSend, composeAlert, shouldEmail } = await import("@/server/alerts");
const { autoBlock } = await import("@/server/threat");
const { addRule } = await import("@/server/ip-rules");
const { resolveSettings } = await import("@/lib/settings-schema");
const { mailIdentity, introLines } = await import("@/server/mail-template");
const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
const { POST: sendCode } = await import("@/app/api/mfa/email/send/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: decoy } = await import("@/app/api/decoy/route");
const { sendPasswordChangedEmail } = await import("@/server/password-reset");
const { findUserById } = await import("@/server/users");
const { randomToken, sha256 } = await import("@/server/crypto");
const consoleRoute = await import("@/app/api/console/[...path]/route");

interface Plunk {
  from: { name: string; email: string };
  reply: string;
  to: string;
  subject: string;
  body: string;
  [k: string]: unknown;
}
let sent: Plunk[] = [];

const ID = mailIdentity();
const SOC = "soc@onlyjewishgirls.com";

beforeEach(() => {
  resetHarness();
  h.env.PLUNK_API_KEY = "sk_test";
  h.cf = { country: "US", city: "Lakewood", region: "New Jersey" };
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What a naive HTML-to-text converter (like Plunk's) is left with: tags dropped, entities decoded. */
function plainText(html: string): string {
  return html
    .replace(/<\/(p|h1|h2|li|ul|div)>|<br\s*\/?>|<hr[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function links(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), text: m[2].replace(/&amp;/g, "&") }));
}

function consoleCall(method: string, path: string, body?: unknown) {
  return call(consoleRoute[method as "POST"] as never, `/api/console/${path}`, {
    method,
    body,
    headers: { "x-requested-with": "console" },
    ctx: { params: Promise.resolve({ path: path.split("/") }) } as never,
  });
}

/** A successful sign-in from `ip`, as the sign-in routes record it in the audit log. */
function signedInFrom(userId: number, username: string, ip: string, at = Date.now() - 60_000) {
  h.d1.exec("INSERT INTO events (at, type, user_id, username, ip) VALUES (?, 'signin.complete', ?, ?, ?)", at, userId, username, ip);
}

/** Sends every kind of email the site sends, through the real routes, and returns them by name. */
async function everyEmail(): Promise<Record<string, Plunk>> {
  const out: Record<string, Plunk> = {};
  const take = (name: string, pick: (m: Plunk) => boolean) => {
    const m = sent.find(pick);
    if (!m) throw new Error(`no ${name} email among: ${sent.map((s) => s.subject).join(" | ")}`);
    out[name] = m;
  };

  const member = await makeUser({ username: "codey" });
  const token = randomToken();
  h.d1.exec(
    "INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at, ip) VALUES (?, ?, 'password', ?, ?, ?, ?)",
    sha256(token), member.id, Date.now(), Date.now(), Date.now() + 600_000, h.ip,
  );
  h.cookies.set("__Host-ojg_session", token);
  expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.ok).toBe(true);
  take("code", (m) => m.subject.includes("Sign-in code"));

  await makeUser({ username: "ruthie" });
  await call(forgot, "/api/auth/forgot-password", { body: { identifier: "ruthie" } });
  await settle();
  take("reset", (m) => m.subject.includes("Password reset requested"));

  const { NextRequest } = await import("next/server");
  sendPasswordChangedEmail(new NextRequest("https://onlyjewishgirls.com/api/auth/change-password"), (await findUserById(member.id))!, { keptThisDevice: true });
  await settle();
  take("changed", (m) => m.subject.includes("Your password was changed"));

  const owner = await makeUser({ username: "owner", role: "owner" });
  await signInAs(owner.id);
  expect((await consoleCall("POST", `people/${member.id}/email`, { subject: "About your streak", body: "Hi,\n\nYour restore was granted.\n\nSee https://onlyjewishgirls.com/home or https://evil.example/x." })).data.ok).toBe(true);
  take("message", (m) => m.subject === "[OnlyJewishGirls] About your streak");
  expect((await consoleCall("POST", `people/${member.id}/password`, { mode: "link" })).data.ok).toBe(true);
  await settle();
  take("adminReset", (m) => m.subject.includes("Password reset link sent by an administrator"));

  await makeUser({ username: "miriam" });
  h.ip = "198.51.100.23";
  await call(login, "/api/auth/login", { body: { identifier: "miriam", password: "bad" } });
  await settle();
  take("failedSignin", (m) => m.subject.includes("Failed sign-in"));

  // Someone who signed in from an address that is then flagged: emailed, naming them.
  h.ip = "192.0.2.66";
  signedInFrom(member.id, "codey", h.ip);
  await call(decoy, "/api/decoy?p=.env");
  await settle();
  take("signedInBlock", (m) => m.subject.includes("after codey signed in from it"));

  // An allowlisted address that is flagged: the owner-lockout style notice.
  h.ip = "192.0.2.77";
  await addRule({ kind: "allow", ip: "192.0.2.77", label: "Office" });
  await call(decoy, "/api/decoy?p=wp-login.php");
  await settle();
  take("allowlistedBlock", (m) => m.subject.includes("allowlisted IP address"));

  h.ip = "203.0.113.10";
  await signInAs(owner.id);
  await autoBlock("203.0.113.10", "failed_logins", "5 wrong passwords in 15 min.", ["5 wrong passwords"], resolveSettings({}));
  await settle();
  take("ownerLockout", (m) => m.subject.includes("owner's IP address"));
  return out;
}

describe("every email carries the business's identity (§6)", () => {
  it("covers each kind of email, with the business in the sender, subject and reply-to, and nothing Plunk would track", async () => {
    const mails = await everyEmail();
    expect(Object.keys(mails).sort()).toEqual(
      ["adminReset", "allowlistedBlock", "changed", "code", "failedSignin", "message", "ownerLockout", "reset", "signedInBlock"].sort(),
    );
    for (const [name, m] of Object.entries(mails)) {
      expect([name, m.subject.startsWith("[OnlyJewishGirls] ")]).toEqual([name, true]);
      expect([name, m.from]).toEqual([name, { name: "OnlyJewishGirls", email: expect.stringMatching(/@onlyjewishgirls\.com$/) }]);
      expect([name, m.reply]).toEqual([name, "info@onlyjewishgirls.com"]);
      expect([name, Object.keys(m).sort()]).toEqual([name, ["body", "from", "reply", "subject", "to"]]);
    }
    // Alerts come from the alert sender; account mail from the account sender.
    expect(mails.failedSignin.from.email).toBe("securityalerts@onlyjewishgirls.com");
    expect(mails.code.from.email).toBe("no-reply@onlyjewishgirls.com");
  });

  it("subjects say plainly what happened, with no [SECURITY] tag, capitals or alarm words", async () => {
    const mails = await everyEmail();
    for (const [name, m] of Object.entries(mails)) {
      if (name !== "message") expect([name, m.subject]).toEqual([name, expect.stringMatching(/^\[OnlyJewishGirls\] [A-Z][^A-Z]*?.* on the member site( \(and \d+ more like it\))?$/)]);
      for (const text of [m.subject, plainText(m.body)]) {
        expect([name, text]).not.toEqual([name, expect.stringMatching(/\[SECURITY\]|act now|immediately|right away|urgent|will be locked|OWNER LOCKOUT|WARNING/i)]);
      }
    }
    expect(mails.failedSignin.subject).toBe("[OnlyJewishGirls] Failed sign-in attempt on the member site");
    expect(mails.code.subject).toBe("[OnlyJewishGirls] Sign-in code requested on the member site");
  });

  it("every body has the legal name, website, support address, who we are and a non-empty 'why you got this'", async () => {
    const mails = await everyEmail();
    for (const [name, m] of Object.entries(mails)) {
      const text = plainText(m.body);
      for (const s of ["OnlyJewishGirls · https://onlyjewishgirls.com · info@onlyjewishgirls.com", "This is an automated notice from the OnlyJewishGirls member site. We will never ask for your password by email.", "This email is from OnlyJewishGirls (https://onlyjewishgirls.com)."]) {
        expect([name, text]).toEqual([name, expect.stringContaining(s)]);
      }
      const why = /You're receiving this because ([^\n]+)/.exec(text)?.[1] ?? "";
      expect([name, why.length > 20]).toEqual([name, true]);
      expect([name, text]).toEqual([name, expect.stringContaining("What you can do")]);
    }
    expect(plainText(mails.failedSignin.body)).toContain("You're receiving this because you're an administrator of the OnlyJewishGirls member site.");
    expect(plainText(mails.code.body)).toContain('You\'re receiving this because this address is the account email for "codey" on the OnlyJewishGirls member site.');
  });

  it("links only point at the site's own domain, and each link's visible text is its URL", async () => {
    const mails = await everyEmail();
    let count = 0;
    for (const [name, m] of Object.entries(mails)) {
      for (const link of links(m.body)) {
        count++;
        expect([name, new URL(link.href).hostname]).toEqual([name, expect.stringMatching(/^(.+\.)?onlyjewishgirls\.com$/)]);
        expect([name, link.text]).toEqual([name, link.href]);
        expect([name, link.href]).not.toEqual([name, expect.stringMatching(/utm_|bit\.ly|tinyurl/i)]);
      }
      // The website is always one of them (the footer).
      expect([name, links(m.body).some((l) => l.href === "https://onlyjewishgirls.com")]).toEqual([name, true]);
    }
    expect(count).toBeGreaterThan(10);
    // An outside URL an admin typed into a console message stays plain text.
    expect(mails.message.body).toContain("https://evil.example/x");
    expect(links(mails.message.body).map((l) => l.href)).not.toContain("https://evil.example/x");
    expect(links(mails.message.body).map((l) => l.href)).toContain("https://onlyjewishgirls.com/home");
    // Alerts never link to a password page: only the console.
    for (const name of ["failedSignin", "signedInBlock", "allowlistedBlock", "ownerLockout", "changed"]) {
      expect([name, links(mails[name].body).some((l) => /password/.test(l.href))]).toEqual([name, false]);
    }
  });

  it("the code email shows the code, its expiry, and that we will never ask for it", async () => {
    const { code } = await everyEmail();
    const text = plainText(code.body);
    const value = /\n(\d{6})\n/.exec(text)?.[1];
    expect(value).toMatch(/^\d{6}$/);
    expect(code.body).toMatch(/font-size:32px[^>]*>\d{6}<\/p>/);
    expect(text).toContain("The code expires in 10 minutes");
    expect(text).toContain("We will never ask you for this code. Don't share it with anyone");
    expect(text).toContain("If you didn't try to sign in, you can ignore this email.");
  });

  it("the reset email says the member asked, and that their password is unchanged if they didn't", async () => {
    const { reset, adminReset } = await everyEmail();
    const text = plainText(reset.body);
    expect(text).toContain('You asked to reset the password for your account "ruthie" on the OnlyJewishGirls member site.');
    expect(text).toContain("If you didn't ask for this, ignore this email: your password is unchanged.");
    const [link] = links(reset.body).filter((l) => l.href.includes("/reset-password?token="));
    expect(link.text).toBe(link.href);
    expect(plainText(adminReset.body)).toContain("An administrator of the OnlyJewishGirls member site sent you this link");
  });

  it("the HTML still reads correctly as plain text: the facts, the actions and the footer", async () => {
    const { failedSignin, code, changed, signedInBlock } = await everyEmail();
    const alert = plainText(failedSignin.body);
    for (const s of [
      "Failed sign-in attempt",
      "Wrong password (account miriam).",
      "Details",
      "Account: miriam",
      "IP address: 198.51.100.23",
      "Approximate location: Lakewood, New Jersey, US",
      "(America/New_York) ·",
      " UTC",
      "Portal: OnlyJewishGirls member site (onlyjewishgirls.com)",
      "What you can do",
      "Review it in the console: https://onlyjewishgirls.com/admin#audit/",
    ]) {
      expect(alert).toContain(s);
    }
    for (const s of ["Account: codey", "Requested: ", "IP address: 203.0.113.10", "Approximate location: Lakewood, New Jersey, US", "Device: Safari on Mac"]) expect(plainText(code.body)).toContain(s);
    expect(plainText(changed.body)).toContain('choose "Forgot password?" on the sign-in page');
    expect(plainText(signedInBlock.body)).toContain("IP address: 192.0.2.66");
    // No layout tables or images for the converter to trip over.
    for (const m of [failedSignin, code, changed, signedInBlock]) expect(m.body).not.toMatch(/<(table|img)\b/i);
  });

  it("the owner-lockout notice is boxed before everything else", async () => {
    const { ownerLockout } = await everyEmail();
    const text = plainText(ownerLockout.body);
    expect(text.indexOf("belongs to the owner's live session")).toBeLessThan(text.indexOf("Details"));
    expect(ownerLockout.body).toContain("border-left:4px solid #b42318");
  });

  it("MAIL_* variables set the identity; defaults otherwise", async () => {
    Object.assign(h.env, {
      MAIL_BUSINESS_NAME: "OJG",
      MAIL_BUSINESS_LEGAL_NAME: "OJG Holdings LLC",
      MAIL_WEBSITE: "https://www.onlyjewishgirls.com/",
      MAIL_SUPPORT_EMAIL: "help@onlyjewishgirls.com",
    });
    await recordAndSend({ event: "test", title: "Test alert", key: "k", what: "A test." }, "onlyjewishgirls.com");
    expect(sent[0]).toMatchObject({ from: { name: "OJG" }, reply: "help@onlyjewishgirls.com", subject: "[OJG] Test alert on the member site" });
    expect(plainText(sent[0].body)).toContain("OJG Holdings LLC · https://www.onlyjewishgirls.com · help@onlyjewishgirls.com");
    expect(mailIdentity({})).toMatchObject({ name: "OnlyJewishGirls", legalName: "OnlyJewishGirls", website: "https://onlyjewishgirls.com", supportEmail: "info@onlyjewishgirls.com", host: "onlyjewishgirls.com" });
    expect(introLines(ID, { kind: "admin" })[1]).toBe("You're receiving this because you're an administrator of the OnlyJewishGirls member site.");
  });

  it("every alert event type has its own plain-words subject and a non-empty 'What you can do'", () => {
    const events = ["failed_signin", "failed_mfa", "account_lockout", "new_device", "admin_signin", "mfa_changed", "password_changed", "role_changed", "user_created", "user_status", "ip_list_changed", "auto_blacklist", "hostile_visitor", "decoy_hit", "admin_access_denied", "country_blocked", "streak_set", "settings_changed", "captcha_off", "test"] as const;
    const subjects = new Set<string>();
    for (const event of events) {
      const mail = composeAlert({ event, title: "x", key: "k", what: "Something happened." }, { identity: ID, timeZone: "America/New_York", auditUrl: "https://onlyjewishgirls.com/admin#alerts", suppressed: 0, now: Date.now() });
      expect([event, mail.subject]).toEqual([event, expect.stringMatching(/^\[OnlyJewishGirls\] .+ on the member site$/)]);
      expect([event, /What you can do\n- \S/.test(mail.text)]).toEqual([event, true]);
      subjects.add(mail.subject);
    }
    expect(subjects.size).toBe(events.length);
  });
});

describe("anonymous traffic is recorded without an email; a flagged signed-in address is emailed (§6)", () => {
  const scanner = async (i: number) => {
    h.ip = `192.0.2.${i}`;
    await call(decoy, i % 2 ? "/api/decoy?p=.env" : "/api/decoy?p=wp-admin/setup.php");
    await settle();
  };

  it("an anonymous scanner burst from 30 addresses sends no email, and every event is recorded", async () => {
    for (let i = 1; i <= 30; i++) await scanner(i);
    expect(sent).toEqual([]);
    expect(h.d1.rows("SELECT * FROM ip_rules WHERE kind = 'deny' AND source = 'auto'")).toHaveLength(30);
    const rows = h.d1.rows<{ event: string; status: string; n: number }>("SELECT event, status, COUNT(*) AS n FROM security_alerts GROUP BY event, status ORDER BY event");
    expect(rows).toEqual([
      { event: "auto_blacklist", status: "suppressed", n: 30 },
      { event: "decoy_hit", status: "suppressed", n: 30 },
      { event: "hostile_visitor", status: "suppressed", n: 30 },
    ]);
    expect(h.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'security.auto_blocked'")!.n).toBe(30);
  });

  it("a member who signs in and then trips a detector from the same address is blocked, with one email naming the account", async () => {
    const member = await makeUser({ username: "chana" });
    h.ip = "198.51.100.40";
    await signInAs(member.id);
    signedInFrom(member.id, "chana", h.ip, Date.now() - 5 * 60_000);
    await call(decoy, "/api/decoy?p=.git/config");
    await settle();
    expect(h.d1.one<{ ip: string }>("SELECT ip FROM ip_rules WHERE kind = 'deny'")?.ip).toBe("198.51.100.40");
    expect(h.d1.rows("SELECT * FROM sessions WHERE user_id = ?", member.id)).toEqual([]);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail).toMatchObject({ to: SOC, subject: "[OnlyJewishGirls] IP address blocked automatically after chana signed in from it on the member site" });
    const text = plainText(mail.body);
    for (const s of [
      "chana signed in successfully from 198.51.100.40 at ",
      "Signed in from this address: chana, ",
      "Account: chana",
      "198.51.100.40 was blocked automatically: Requested a scanner/decoy path.",
      "Evidence: GET /.git/config",
      "unblock the address from the console's Deny list (https://onlyjewishgirls.com/admin#deny)",
    ]) {
      expect(text).toContain(s);
    }
    // The decoy hit and the hostile score from the same address stay recorded, not emailed.
    expect(h.d1.rows<{ event: string; status: string }>("SELECT event, status FROM security_alerts ORDER BY id")).toEqual([
      { event: "decoy_hit", status: "suppressed" },
      { event: "hostile_visitor", status: "suppressed" },
      { event: "auto_blacklist", status: "sent" },
    ]);
  });

  it("a sign-in more than 24 hours ago doesn't count: the block is recorded, not emailed", async () => {
    const member = await makeUser({ username: "old" });
    h.ip = "198.51.100.41";
    signedInFrom(member.id, "old", h.ip, Date.now() - 25 * 60 * 60_000);
    await call(decoy, "/api/decoy?p=.env");
    await settle();
    expect(sent).toEqual([]);
    expect(h.d1.one<{ status: string }>("SELECT status FROM security_alerts WHERE event = 'auto_blacklist'")?.status).toBe("suppressed");
  });

  it("an allowlisted address that is flagged gets the owner-lockout style notice", async () => {
    h.ip = "198.51.100.50";
    await addRule({ kind: "allow", ip: "198.51.100.50", label: "Office" });
    await call(decoy, "/api/decoy?p=.env");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("[OnlyJewishGirls] An allowlisted IP address was blocked automatically on the member site");
    const text = plainText(sent[0].body);
    expect(text.indexOf("was on the IP allowlist")).toBeLessThan(text.indexOf("Details"));
    expect(sent[0].body).toContain("border-left:4px solid #b42318");
    expect(h.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM ip_rules WHERE kind = 'allow' AND revoked_at IS NULL")!.n).toBe(0);
  });

  it("the owner's address is emailed as an owner lockout even with no sign-in event", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    h.ip = "198.51.100.60";
    await signInAs(owner.id);
    await autoBlock("198.51.100.60", "decoy", "Requested a scanner/decoy path.", ["GET /.env"], resolveSettings({}));
    await settle();
    expect(sent.map((m) => m.subject)).toEqual(["[OnlyJewishGirls] The owner's IP address was blocked automatically on the member site"]);
  });

  it("failed sign-ins for accounts that don't exist and country refusals are recorded, not emailed", async () => {
    h.ip = "198.51.100.70";
    await call(login, "/api/auth/login", { body: { identifier: "nobody-here", password: "x" } });
    await settle();
    expect(sent).toEqual([]);
    expect(h.d1.one<{ status: string }>("SELECT status FROM security_alerts WHERE event = 'failed_signin'")?.status).toBe("suppressed");
    expect(shouldEmail({ event: "country_blocked", title: "x", key: "country:DE", what: "x" })).toBe(false);
    expect(shouldEmail({ event: "admin_access_denied", title: "x", key: "x", what: "x" })).toBe(false);
    expect(shouldEmail({ event: "admin_access_denied", title: "x", key: "x", what: "x", user: { id: 1, username: "m" } })).toBe(true);
    expect(shouldEmail({ event: "failed_signin", title: "x", key: "x", what: "x", user: { id: 1, username: "m" } })).toBe(true);
  });

  it("account notices keep their own per-account dedupe (not the hourly digest)", async () => {
    const t0 = Date.now();
    const signin = (key: string, now: number) => recordAndSend({ event: "new_device", title: "Signed in", key, what: "x", now }, "onlyjewishgirls.com");
    await signin("u1:a", t0);
    await signin("u2:b", t0 + 1000);
    await signin("u1:a", t0 + 11 * 60_000);
    expect(sent).toHaveLength(3);
  });

  it("scanner, decoy, hostile and admin-denied alerts never go to a member or staff address", async () => {
    const member = await makeUser({ username: "member" });
    const admin = await makeUser({ username: "admin", role: "admin" });
    await signInAs(member.id);
    // A member poking at the console: admin-denied strikes, then an auto-blacklist.
    for (let i = 0; i < 3; i++) await consoleCall("GET", "people");
    h.ip = "192.0.2.77";
    await call(decoy, "/api/decoy?p=wp-admin");
    await settle();
    const events = h.d1.rows<{ event: string; to_addr: string }>("SELECT event, to_addr FROM security_alerts");
    expect(new Set(events.map((e) => e.event))).toEqual(new Set(["admin_access_denied", "auto_blacklist", "decoy_hit", "hostile_visitor"]));
    // The member's refused console requests are emailed (an account is involved); the anonymous scanner isn't.
    expect(events.every((e) => e.to_addr === SOC)).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.to === SOC)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(`${member.username}@example.com`);
    expect(JSON.stringify(sent)).not.toContain(`${admin.username}@example.com`);
  });

  it("sign-in codes are never delayed: each request sends its own email at once", async () => {
    const u = await makeUser({ username: "fast" });
    const token = randomToken();
    h.d1.exec(
      "INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at, ip) VALUES (?, ?, 'password', ?, ?, ?, ?)",
      sha256(token), u.id, Date.now(), Date.now(), Date.now() + 600_000, h.ip,
    );
    h.cookies.set("__Host-ojg_session", token);
    sent = [];
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "fast@example.com", subject: "[OnlyJewishGirls] Sign-in code requested on the member site" });
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE dedupe_key LIKE '%fast%'")).toEqual([]);
  });
});
