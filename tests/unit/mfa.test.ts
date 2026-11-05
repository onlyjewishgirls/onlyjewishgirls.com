import { beforeEach, describe, expect, it, vi } from "vitest";
import { call, h, makeUser, resetHarness, signInAs } from "./harness";

const { POST: totpVerify } = await import("@/app/api/mfa/totp/verify/route");
const { POST: recoveryVerify } = await import("@/app/api/mfa/recovery-codes/verify/route");
const { POST: passkeyVerify } = await import("@/app/api/mfa/passkey/authenticate/verify/route");
const { POST: passkeyLoginVerify } = await import("@/app/api/auth/passkey/verify/route");
const { encrypt, randomToken, sha256 } = await import("@/server/crypto");
const { base32Decode, generateTotpSecret, hotp, totpStep } = await import("@/server/totp");

let secret: string;

async function passwordStage(userId: number, challenge: string | null = null) {
  const token = randomToken();
  const now = Date.now();
  h.d1.exec(
    `INSERT INTO sessions (id_hash, user_id, stage, challenge, challenge_expires_at, created_at, last_seen_at, expires_at, ip)
     VALUES (?, ?, 'password', ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    challenge,
    challenge ? now + 60_000 : null,
    now,
    now,
    now + 600_000,
    h.ip,
  );
  h.cookies.set("__Host-ojg_session", token);
}

beforeEach(async () => {
  resetHarness();
  secret = generateTotpSecret();
});

async function totpUser() {
  const u = await makeUser({ username: "naomi" });
  h.d1.exec("UPDATE users SET totp_secret_enc = ? WHERE id = ?", encrypt(secret), u.id);
  await passwordStage(u.id);
  return u;
}

describe("PORTAL-STANDARD §2: exact second-factor errors", () => {
  it("mfa_wrong_code: incorrect, with tries left, under the code field", async () => {
    await totpUser();
    const r = await call(totpVerify, "/api/mfa/totp/verify", { body: { code: "000000" } });
    expect(r.data).toMatchObject({ code: "mfa_wrong_code", field: "code", error: "That code is incorrect. 4 tries left on this sign-in." });
  });

  it("mfa_wrong_code: an expired code says so", async () => {
    await totpUser();
    const old = hotp(base32Decode(secret), totpStep(Date.now()) - 6);
    const r = await call(totpVerify, "/api/mfa/totp/verify", { body: { code: old } });
    expect(r.data.error).toMatch(/^That code has expired; use the code your app shows now\./);
  });

  it("a correct code signs in fully", async () => {
    await totpUser();
    const r = await call(totpVerify, "/api/mfa/totp/verify", { body: { code: hotp(base32Decode(secret), totpStep(Date.now())) } });
    expect(r.data).toMatchObject({ next: "/home" });
  });

  it("5 wrong tries end the sign-in; 5 from one IP blocks the address", async () => {
    await totpUser();
    let r;
    for (let i = 0; i < 5; i++) r = await call(totpVerify, "/api/mfa/totp/verify", { body: { code: "000000" } });
    expect(r!.data.code).toBe("ip_blocked");
    expect(h.d1.one<{ trigger_kind: string }>("SELECT trigger_kind FROM ip_rules WHERE kind = 'deny'")?.trigger_kind).toBe("failed_mfa");
  });

  it("recovery codes: incorrect vs already used", async () => {
    const u = await makeUser({ username: "ruth" });
    await passwordStage(u.id);
    h.d1.exec("INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, 1)", u.id, sha256("ABCDEFGHJK"));
    const used = await call(recoveryVerify, "/api/mfa/recovery-codes/verify", { body: { code: "ABCDE-FGHJK" } });
    expect(used.data.error).toMatch(/^That recovery code was already used\. Each one works once\./);
    const wrong = await call(recoveryVerify, "/api/mfa/recovery-codes/verify", { body: { code: "ZZZZZ-ZZZZZ" } });
    expect(wrong.data.error).toMatch(/^That recovery code is incorrect\./);
  });

  it("passkey_failed: not registered on this account", async () => {
    const u = await makeUser({ username: "esther" });
    await passwordStage(u.id, "challenge-1");
    const r = await call(passkeyVerify, "/api/mfa/passkey/authenticate/verify", {
      body: { id: "someone-elses", rawId: "x", type: "public-key", response: { clientDataJSON: "", authenticatorData: "", signature: "" } },
    });
    expect(r.data).toMatchObject({ code: "passkey_failed", error: expect.stringMatching(/^That passkey is not registered on the account esther\./) });
  });

  it("passkey_failed: signature invalid", async () => {
    const u = await makeUser({ username: "devorah" });
    await passwordStage(u.id, "challenge-2");
    const r = await call(passkeyVerify, "/api/mfa/passkey/authenticate/verify", {
      body: { id: `pk-${u.id}`, rawId: `pk-${u.id}`, type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" }, clientExtensionResults: {} },
    });
    expect(r.data.code).toBe("passkey_failed");
    expect(r.data.error).toMatch(/^The passkey's signature is invalid/);
  });

  it("usernameless passkey: unknown credential and expired challenge are stated", async () => {
    const cd = (challenge: string) => Buffer.from(JSON.stringify({ type: "webauthn.get", challenge })).toString("base64url");
    const expired = await call(passkeyLoginVerify, "/api/auth/passkey/verify", { body: { id: "nope", response: { clientDataJSON: cd("abc") } } });
    expect(expired.data).toMatchObject({ code: "passkey_failed", error: "The passkey request expired or was already used. Try again." });
    h.d1.exec("INSERT INTO webauthn_challenges (challenge, expires_at) VALUES ('abc', ?)", Date.now() + 60_000);
    const unknown = await call(passkeyLoginVerify, "/api/auth/passkey/verify", { body: { id: "nope", response: { clientDataJSON: cd("abc") } } });
    expect(unknown.data.error).toBe("That passkey is not registered on any account here. Sign in with your password instead.");
  });
});

const { POST: sendCode } = await import("@/app/api/mfa/email/send/route");
const { POST: verifyCode } = await import("@/app/api/mfa/email/verify/route");
const consoleRoute = await import("@/app/api/console/[...path]/route");
const { mfaState } = await import("@/server/mfa");
const { findUserById } = await import("@/server/users");

describe("email codes, the third factor (§3)", () => {
  let mails: { to: string[]; subject: string; text: string }[] = [];
  // Security alerts go through the same transport; only the sign-in code emails count here.
  const codeMails = () => mails.filter((m) => m.subject.endsWith("sign-in code"));
  const lastCode = () => /code is (\d{6})/.exec(codeMails()[codeMails().length - 1].text)![1];
  const configure = () => {
    h.env.EMAIL_API_KEY = "re_test";
    h.env.EMAIL_FROM = "OnlyJewishGirls <no-reply@onlyjewishgirls.com>";
    mails = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      mails.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    });
  };

  it("isn't offered when email isn't configured", async () => {
    const u = await makeUser({ username: "noemail" });
    await passwordStage(u.id);
    expect((await mfaState((await findUserById(u.id))!)).email).toBe(false);
    const r = await call(sendCode, "/api/mfa/email/send", { body: {} });
    expect(r.data).toMatchObject({ code: "email_unavailable", error: "Email codes aren't available: this site's email isn't configured." });
  });

  it("6 digits by email, single use, exact errors: incorrect, then already used", async () => {
    configure();
    const u = await makeUser({ username: "emailer" });
    await passwordStage(u.id);
    const sent = await call(sendCode, "/api/mfa/email/send", { body: {} });
    expect(sent.data.message).toMatch(/^We emailed a 6-digit code to em•••@example\.com\. It expires in 10 minutes\.$/);
    expect(codeMails()[0]).toMatchObject({ to: ["emailer@example.com"], subject: expect.stringMatching(/^\d{6} is your OnlyJewishGirls sign-in code$/) });
    expect(h.d1.one<{ code_hash: string }>("SELECT code_hash FROM email_codes")!.code_hash).not.toContain(lastCode());
    const code = lastCode();
    const wrong = await call(verifyCode, "/api/mfa/email/verify", { body: { code: code === "000000" ? "111111" : "000000" } });
    expect(wrong.data).toMatchObject({ code: "mfa_wrong_code", field: "code", error: "That code is incorrect. 4 tries left on this sign-in." });
    const ok = await call(verifyCode, "/api/mfa/email/verify", { body: { code } });
    expect(ok.data).toMatchObject({ next: "/home" });
    expect(h.d1.one<{ detail: string }>("SELECT detail FROM events WHERE type = 'signin.complete'")!.detail).toContain('"email"');
    await passwordStage(u.id);
    const again = await call(verifyCode, "/api/mfa/email/verify", { body: { code } });
    expect(again.data.error).toMatch(/^That code was already used\. Request a new one\./);
    vi.unstubAllGlobals();
  });

  it("expires after 10 minutes; a newer code replaces the old one; resend waits a minute", async () => {
    configure();
    const u = await makeUser({ username: "slowpoke" });
    await passwordStage(u.id);
    await call(sendCode, "/api/mfa/email/send", { body: {} });
    const first = lastCode();
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.error).toMatch(/^A code was sent less than a minute ago\. Wait \d+ s/);
    h.d1.exec("UPDATE email_codes SET created_at = created_at - 120000");
    const third = await call(sendCode, "/api/mfa/email/send", { body: {} });
    expect(third.data).toMatchObject({ ok: true });
    const old = await call(verifyCode, "/api/mfa/email/verify", { body: { code: first } });
    if (first !== lastCode()) expect(old.data.error).toMatch(/^That code has expired; request a new one\./);
    h.d1.exec("UPDATE email_codes SET expires_at = ?", Date.now() - 1);
    const late = await call(verifyCode, "/api/mfa/email/verify", { body: { code: lastCode() } });
    expect(late.data.error).toMatch(/^That code has expired; request a new one\./);
    vi.unstubAllGlobals();
  });

  it("is off for 24 h after a reset by email, off when an admin turns it off, and doesn't skip first setup", async () => {
    configure();
    const u = await makeUser({ username: "resetme" });
    h.d1.exec("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES ('t', ?, ?, ?, ?)", u.id, Date.now() - 1000, Date.now() + 1e6, Date.now() - 500);
    await passwordStage(u.id);
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.error).toMatch(/^Email codes are off for 24 hours after a password reset by email/);

    const fresh = await makeUser({ username: "brandnew", passkey: false, totp: false });
    h.d1.exec("UPDATE users SET recovery_codes_created_at = NULL WHERE id = ?", fresh.id);
    h.d1.exec("DELETE FROM recovery_codes WHERE user_id = ?", fresh.id);
    const s = await mfaState((await findUserById(fresh.id))!);
    expect(s).toMatchObject({ email: false, factors: 0 });

    // The console lists it after the authenticator app, and the owner can turn it off.
    const owner = await makeUser({ username: "boss", role: "owner" });
    const member = await makeUser({ username: "mem" });
    await signInAs(owner.id);
    const c = (method: string, path: string, body?: unknown) =>
      call(consoleRoute[method as "GET"] as never, `/api/console/${path}`, {
        method,
        body,
        headers: { "x-requested-with": "console" },
        ctx: { params: Promise.resolve({ path: path.split("/") }) } as never,
      });
    expect(((await c("GET", "bootstrap")).data.features as Record<string, boolean>).mfa_email_toggle).toBe(true);
    const rec = (await c("GET", `people/${member.id}`)).data as { mfa: { methods: { kind: string; toggle?: boolean }[] }; person: { mfa: string[] } };
    expect(rec.mfa.methods.map((m) => m.kind)).toEqual(["passkey", "totp", "email", "recovery"]);
    expect(rec.person.mfa).toEqual(["passkey", "totp", "email", "recovery"]);
    expect((await c("POST", `people/${member.id}/mfa/email`, { enabled: false })).data.ok).toBe(true);
    await passwordStage(member.id);
    expect((await call(sendCode, "/api/mfa/email/send", { body: {} })).data.error).toBe("Email codes are turned off for this account by an administrator.");
    vi.unstubAllGlobals();
  });
});
