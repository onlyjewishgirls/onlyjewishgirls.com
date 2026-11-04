import { beforeEach, describe, expect, it } from "vitest";
import { streakCalendar, type Place } from "@/lib/streak/calendar";
import { recordActivity, type StreakState } from "@/lib/streak/engine";
import { monthKey, restorePlan, setPlan } from "@/lib/streak/restore";
import { call, h, makeUser, resetHarness, signInAs } from "./harness";

const NY: Place = { timeZone: "America/New_York", israel: false, latitude: 40.7128, longitude: -74.006 };
const ny = streakCalendar(NY);
const t = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

describe("restorePlan / setPlan (ported from WAMV streak.js)", () => {
  // Tue 10 Nov 2026 – a plain week, no Yom Tov.
  const tue = t("2026-11-10T15:00:00Z");
  const live: StreakState = { count: 12, longest: 20, lastActivityAt: tue, lastCountedDate: "2026-11-10", startedAt: tue - 11 * 24 * HOUR };

  it("nothing to restore on a live streak", () => {
    expect(restorePlan(live, null, tue + 2 * HOUR, ny)).toBeNull();
  });

  it("a streak that broke on today's check-in restores to the lost count plus today", () => {
    const thu = tue + 50 * HOUR; // past the 30-hour window
    const broke = recordActivity(live, thu, ny);
    expect(broke.outcome).toBe("restarted");
    const event = { date: "2026-11-12", outcome: "restarted" as const, added: 1, previousCount: 12 };
    const plan = restorePlan(broke.state, event, thu + HOUR, ny)!;
    expect(plan).toMatchObject({ from: 1, to: 13 });
    expect(plan.state.count).toBe(13);
    // Only once, and only on the day it broke.
    expect(restorePlan(broke.state, { ...event, restored: true }, thu + HOUR, ny)).toBeNull();
    expect(restorePlan(broke.state, { ...event, date: "2026-11-11" }, thu + HOUR, ny)).toBeNull();
  });

  it("a lapsed streak with no check-in since restores to count + 1 and restarts the window", () => {
    const later = tue + 40 * HOUR;
    const plan = restorePlan(live, null, later, ny)!;
    expect(plan).toMatchObject({ from: 0, to: 13 });
    expect(plan.state.lastActivityAt).toBe(later);
  });

  it("setPlan: N includes today, the window restarts now, 0 clears but keeps the longest", () => {
    const s = setPlan(live, 40, tue, "America/New_York")!;
    expect(s).toMatchObject({ count: 40, longest: 40, lastActivityAt: tue, lastCountedDate: "2026-11-10" });
    expect(setPlan(live, 0, tue, "America/New_York")).toEqual({ count: 0, longest: 20, lastActivityAt: null, lastCountedDate: null, startedAt: null });
    expect(setPlan(live, 10_001, tue, "America/New_York")).toBeNull();
    expect(setPlan(live, 1.5, tue, "America/New_York")).toBeNull();
  });

  it("months are calendar months in the portal time zone", () => {
    // 00:30 UTC on 1 Dec is still 30 Nov in New York.
    expect(monthKey(t("2026-12-01T00:30:00Z"), "America/New_York")).toBe("2026-11");
    expect(monthKey(t("2026-12-01T00:30:00Z"), "UTC")).toBe("2026-12");
  });
});

const { POST: restore } = await import("@/app/api/streak/restore/route");
const consoleRoute = await import("@/app/api/console/[...path]/route");

function lose(userId: number, previous = 12) {
  const now = Date.now();
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  h.d1.exec(
    `UPDATE users SET streak_count = 1, streak_longest = ?, streak_last_activity_at = ?, streak_last_counted_date = ?, streak_started_at = ?,
       streak_last_event = ? WHERE id = ?`,
    previous,
    now,
    today,
    now,
    JSON.stringify({ date: today, outcome: "restarted", added: 1, previousCount: previous }),
    userId,
  );
}

const consoleCall = (method: string, path: string, body?: unknown) =>
  call(consoleRoute[method as "GET"] as never, `/api/console/${path}`, {
    method,
    body,
    headers: { "x-requested-with": "console" },
    ctx: { params: Promise.resolve({ path: path.split("?")[0].split("/") }) } as never,
  });

describe("courtesy restore (§4)", () => {
  beforeEach(() => resetHarness());

  it("allows N per month (default 3), logs each, then refuses", async () => {
    const u = await makeUser();
    await signInAs(u.id);
    for (let i = 1; i <= 3; i++) {
      lose(u.id, 10 + i);
      const r = await call(restore, "/api/streak/restore", { body: {} });
      expect(r.data).toMatchObject({ ok: true, to: 11 + i, left: 3 - i });
    }
    lose(u.id);
    const r = await call(restore, "/api/streak/restore", { body: {} });
    expect(r.data).toMatchObject({ ok: false, code: "no_restores_left" });
    const rows = h.d1.rows<{ kind: string; by_user_id: number; month: string }>("SELECT * FROM streak_restores");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "self", by_user_id: u.id });
    expect(h.d1.one("SELECT COUNT(*) AS n FROM events WHERE type = 'streak.restored'")!.n).toBe(3);
    expect(h.d1.one("SELECT COUNT(*) AS n FROM events WHERE type = 'streak.restore_refused'")!.n).toBe(1);
  });

  it("0 turns restores off; an admin grant adds to the month", async () => {
    h.d1.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('streak_restores', '0', 1)`);
    const u = await makeUser();
    await signInAs(u.id);
    lose(u.id);
    expect((await call(restore, "/api/streak/restore", { body: {} })).data.code).toBe("restores_off");
  });

  it("refuses when there's nothing to restore", async () => {
    const u = await makeUser();
    await signInAs(u.id);
    expect((await call(restore, "/api/streak/restore", { body: {} })).data.code).toBe("nothing_to_restore");
  });
});

describe("admin set-streak (§4)", () => {
  beforeEach(() => resetHarness());

  it("the owner can set anyone's streak, including their own; it doesn't use restores and it alerts", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    const member = await makeUser({ username: "member" });
    await signInAs(owner.id);
    const self = await consoleCall("POST", `people/${owner.id}/streak`, { current: 25 });
    expect(self.data).toMatchObject({ ok: true, streak: { current: 25 } });
    const other = await consoleCall("POST", `people/${member.id}/streak`, { current: 7 });
    expect(other.data).toMatchObject({ ok: true, streak: { current: 7, restores_used: 0, restores_left: 3 } });
    const log = h.d1.rows<{ kind: string; to_count: number }>("SELECT kind, to_count FROM streak_restores ORDER BY id");
    expect(log).toEqual([
      { kind: "admin", to_count: 25 },
      { kind: "admin", to_count: 7 },
    ]);
    expect(h.d1.one("SELECT COUNT(*) AS n FROM events WHERE type = 'admin.set_streak'")!.n).toBe(2);
    expect(h.d1.rows("SELECT * FROM security_alerts WHERE event = 'streak_set'").length).toBeGreaterThan(0);
  });

  it("an admin needs streaks.manage and can never set their own", async () => {
    const owner = await makeUser({ username: "owner", role: "owner" });
    const admin = await makeUser({ username: "adm", role: "admin" });
    const member = await makeUser({ username: "mem" });
    await signInAs(admin.id);
    const denied = await consoleCall("POST", `people/${member.id}/streak`, { current: 5 });
    expect(denied.status).toBe(403);
    expect(denied.data).toMatchObject({ code: "forbidden", perm: "streaks.manage" });

    // The owner grants the permission.
    h.cookies.clear();
    await signInAs(owner.id);
    expect((await consoleCall("POST", `people/${admin.id}/permissions`, { permissions: ["streaks.manage"] })).data.ok).toBe(true);

    h.cookies.clear();
    await signInAs(admin.id);
    expect((await consoleCall("POST", `people/${member.id}/streak`, { current: 5 })).data).toMatchObject({ ok: true });
    const own = await consoleCall("POST", `people/${admin.id}/streak`, { current: 99 });
    expect(own.data).toMatchObject({ code: "forbidden", error: "Only the owner can set their own streak." });
    // Grant extra restores for the month.
    const g = await consoleCall("POST", `people/${member.id}/streak/restores`, { extra: 2 });
    expect(g.data).toMatchObject({ ok: true, streak: { restores_left: 5, restores_extra: 2 } });
    expect((await consoleCall("POST", `people/${member.id}/streak`, { current: 10001 })).data.code).toBe("validation");
  });
});
