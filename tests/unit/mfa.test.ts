import { beforeEach, describe, expect, it } from "vitest";
import { call, h, makeUser, resetHarness } from "./harness";

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
