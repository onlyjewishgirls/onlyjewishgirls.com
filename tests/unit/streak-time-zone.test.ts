/**
 * Weekend grace, whole days and the person's own time zone (PORTAL-STANDARD §4),
 * through the real routes and server modules: sign-in captures the browser's
 * zone, the check-in judges the streak by it, the settings switch the rule, and
 * an admin's change to someone's zone is audited, alerted and undoable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { call, h, makeUser, resetHarness, settle, signInAs } from "./harness";

const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: totpVerify } = await import("@/app/api/mfa/totp/verify/route");
const consoleRoute = await import("@/app/api/console/[...path]/route");
const { checkIn } = await import("@/server/streak");
const { findUserById } = await import("@/server/users");
const { encrypt } = await import("@/server/crypto");
const { base32Decode, generateTotpSecret, hotp, totpStep } = await import("@/server/totp");

const t = (iso: string) => Date.parse(iso);
const THURSDAY = "2026-11-19T12:00:00-05:00";
const MONDAY_NIGHT = t("2026-11-23T23:30:00-05:00");
const TUESDAY = t("2026-11-24T00:30:00-05:00");

const consoleCall = (method: string, path: string, body?: unknown) =>
  call(consoleRoute[method as "GET"] as never, `/api/console/${path}`, {
    method,
    body,
    headers: { "x-requested-with": "console" },
    ctx: { params: Promise.resolve({ path: path.split("?")[0].split("/") }) } as never,
  });

/** A 5-day streak whose last check-in was `iso`, counted on `date` (backdating the row, as the runtime check does). */
function lastCheckIn(userId: number, iso: string, date = iso.slice(0, 10)) {
  h.d1.exec(
    `UPDATE users SET streak_count = 5, streak_longest = 5, streak_last_activity_at = ?, streak_last_counted_date = ?,
       streak_started_at = ?, streak_last_event = NULL WHERE id = ?`,
    t(iso),
    date,
    t(iso) - 4 * 86_400_000,
    userId,
  );
}

const setting = (key: string, value: unknown) =>
  h.d1.exec("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)", key, JSON.stringify(value));

async function checkInAt(userId: number, now: number) {
  return checkIn((await findUserById(userId))!, now);
}

const storedZone = (id: number) => h.d1.one<{ time_zone: string }>("SELECT time_zone FROM users WHERE id = ?", id)!.time_zone;

beforeEach(() => resetHarness());

describe("Thursday → Monday through the real sign-in", () => {
  it("password + authenticator sign-in records the zone, and the check-in keeps the streak", async () => {
    const u = await makeUser({ username: "shira" });
    const secret = generateTotpSecret();
    h.d1.exec("UPDATE users SET totp_secret_enc = ?, time_zone = 'UTC' WHERE id = ?", encrypt(secret), u.id);
    lastCheckIn(u.id, THURSDAY);

    const pw = await call(login, "/api/auth/login", { body: { identifier: "shira", password: u.password, timeZone: "America/New_York" } });
    expect(pw.data).toMatchObject({ ok: true });
    expect(storedZone(u.id)).toBe("America/New_York");

    // The second step sends it again, in the header every postJson carries.
    h.d1.exec("UPDATE users SET time_zone = 'UTC' WHERE id = ?", u.id);
    const code = hotp(base32Decode(secret), totpStep(Date.now()));
    const mfa = await call(totpVerify, "/api/mfa/totp/verify", { body: { code }, headers: { "x-time-zone": "America/New_York" } });
    expect(mfa.status).toBe(200);
    expect(storedZone(u.id)).toBe("America/New_York");

    const r = await checkInAt(u.id, MONDAY_NIGHT);
    expect(r.today).toMatchObject({ outcome: "continued", added: 2 }); // Monday, plus Shabbat
    // Signed in at 23:30, the 30-hour floor (Wednesday 05:30) outlasts the end of Tuesday.
    expect(r.status).toMatchObject({ alive: true, count: 7, dueDate: null, deadline: MONDAY_NIGHT + 30 * 3_600_000 });
    expect(h.d1.one("SELECT streak_count FROM users WHERE id = ?", u.id)!.streak_count).toBe(7);
  });

  it("Tuesday is too late", async () => {
    const u = await makeUser();
    lastCheckIn(u.id, THURSDAY);
    const r = await checkInAt(u.id, TUESDAY);
    expect(r.today).toMatchObject({ outcome: "restarted", previousCount: 5 });
    expect(r.status.count).toBe(1);
  });
});

describe("the stored time zone decides the days", () => {
  // Thursday 21:00 in Los Angeles is Friday 07:00 in Jerusalem; Monday 23:30 there is Tuesday 09:30 in Jerusalem.
  const thuLA = "2026-11-19T21:00:00-08:00";
  const monLA = t("2026-11-23T23:30:00-08:00");

  it("Los Angeles keeps it; the same instants in Jerusalem break it", async () => {
    const la = await makeUser({ username: "la" });
    const jlm = await makeUser({ username: "jlm" });
    h.d1.exec("UPDATE users SET time_zone = 'America/Los_Angeles' WHERE id = ?", la.id);
    h.d1.exec("UPDATE users SET time_zone = 'Asia/Jerusalem' WHERE id = ?", jlm.id);
    lastCheckIn(la.id, thuLA, "2026-11-19");
    lastCheckIn(jlm.id, thuLA, "2026-11-20");
    expect((await checkInAt(la.id, monLA)).today?.outcome).toBe("continued");
    expect((await checkInAt(jlm.id, monLA)).today?.outcome).toBe("restarted");
  });

  it("an unusable stored zone falls back to the portal's", async () => {
    const u = await makeUser();
    h.d1.exec("UPDATE users SET time_zone = 'Not/AZone' WHERE id = ?", u.id);
    setting("time_zone", "America/Los_Angeles");
    lastCheckIn(u.id, thuLA, "2026-11-19");
    const r = await checkInAt(u.id, monLA);
    expect(r.place.timeZone).toBe("America/Los_Angeles");
    expect(r.today?.outcome).toBe("continued");
  });
});

describe("an invalid time zone from the browser is ignored", () => {
  it("in the body and in the header", async () => {
    const u = await makeUser({ username: "tova" });
    const r = await call(login, "/api/auth/login", {
      body: { identifier: "tova", password: u.password, timeZone: "Mars/Base" },
      headers: { "x-time-zone": "<script>alert(1)</script>" },
    });
    expect(r.data).toMatchObject({ ok: true });
    expect(storedZone(u.id)).toBe("America/New_York");
  });

  it("but a valid header is used when the body has none, canonicalised", async () => {
    const u = await makeUser({ username: "gila" });
    await call(login, "/api/auth/login", { body: { identifier: "gila", password: u.password }, headers: { "x-time-zone": "asia/kolkata" } });
    // Whatever this runtime's ICU calls it (Node 22 still says Asia/Calcutta).
    expect(storedZone(u.id)).toBe(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone);
  });
});

describe("Settings → Streaks restore the old rule", () => {
  it("both off: Thursday → Monday breaks (30 hours, moved past Shabbat only)", async () => {
    setting("streak_weekend_grace", false);
    setting("streak_calendar_days", false);
    const u = await makeUser();
    lastCheckIn(u.id, THURSDAY);
    const r = await checkInAt(u.id, MONDAY_NIGHT);
    expect(r.today?.outcome).toBe("restarted");
    expect(r.calendar.rules).toEqual({ weekendGrace: false, calendarDays: false });
  });

  it("are console settings, default on, audited and alerted", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    await signInAs(owner.id);
    const s = await consoleCall("GET", "settings");
    const items = s.data.items as { key: string; value: unknown; default: unknown; label: string }[];
    expect(items.find((i) => i.key === "streak_weekend_grace")).toMatchObject({ value: true, default: true, label: "Friday and Sunday are grace days" });
    expect(items.find((i) => i.key === "streak_calendar_days")).toMatchObject({ value: true, default: true, label: "Whole days in each person's time zone" });
    const ok = await consoleCall("PATCH", "settings", { values: { streak_weekend_grace: false, streak_calendar_days: false } });
    expect(ok.data).toMatchObject({ ok: true, changed: ["streak_weekend_grace", "streak_calendar_days"] });
    await settle();
    expect(h.d1.one("SELECT detail FROM events WHERE type = 'admin.settings'")!.detail).toContain("streak_weekend_grace: true → false");
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'settings_changed'").length).toBeGreaterThan(0);
  });
});

describe("an admin changing someone's time zone", () => {
  it("is shown on the record, validated, audited, alerted and undoable", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    const member = await makeUser({ username: "member" });
    await signInAs(owner.id);

    const rec = await consoleCall("GET", `people/${member.id}`);
    const field = (rec.data.fields as { key: string; value: string; editable: boolean; options: { value: string }[] }[]).find((f) => f.key === "time_zone")!;
    expect(field).toMatchObject({ value: "America/New_York", editable: true, type: "timezone" });
    expect(field.options.map((o) => o.value)).toContain("Asia/Jerusalem");

    const bad = await consoleCall("PATCH", `people/${member.id}`, { time_zone: "Mars/Base" });
    expect(bad.status).toBe(400);
    expect(bad.data).toMatchObject({ code: "validation", field: "time_zone" });
    expect(storedZone(member.id)).toBe("America/New_York");

    const ok = await consoleCall("PATCH", `people/${member.id}`, { time_zone: "Asia/Jerusalem" });
    expect(ok.status).toBe(200);
    expect(storedZone(member.id)).toBe("Asia/Jerusalem");
    await settle();
    const ev = h.d1.one<{ id: number; detail: string; undo: string }>("SELECT id, detail, undo FROM events WHERE type = 'admin.set_time_zone'")!;
    expect(JSON.parse(ev.detail)).toEqual({ from: "America/New_York", to: "Asia/Jerusalem" });
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'streak_set'").length).toBeGreaterThan(0);

    const { parseUndo, applyUndo } = await import("@/server/admin-undo");
    expect(await applyUndo((await findUserById(member.id))!, parseUndo(ev.undo)!)).toBeNull();
    expect(storedZone(member.id)).toBe("America/New_York");
  });

  it("needs streaks.manage, like setting a streak", async () => {
    const admin = await makeUser({ username: "adm", role: "admin" });
    const member = await makeUser({ username: "mem" });
    await signInAs(admin.id);
    const rec = await consoleCall("GET", `people/${member.id}`);
    expect((rec.data.fields as { key: string; editable: boolean }[]).find((f) => f.key === "time_zone")).toMatchObject({ editable: false });
    const denied = await consoleCall("PATCH", `people/${member.id}`, { time_zone: "Asia/Jerusalem" });
    expect(denied.status).toBe(403);
    expect(storedZone(member.id)).toBe("America/New_York");
  });
});
