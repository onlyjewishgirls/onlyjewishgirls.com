import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEADERBOARD_COLUMNS } from "@/lib/streak/leaderboard-query";

// A stand-in for the users table, answering the leaderboard's query the way SQLite would (the query
// itself runs on real SQLite in leaderboard-sql.test.ts). It returns only the columns the query selects,
// so a column the code needs but the query forgot would show up here as a missing value.
interface FakeUser {
  id: number;
  username: string;
  streak_count: number;
  streak_last_activity_at: number;
  suspended?: boolean;
  time_zone?: string;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}
let users: FakeUser[] = [];
let cacheSeconds: string | number | undefined;
const queries: { sql: string; params: unknown[] }[] = [];

vi.mock("@/server/db", () => ({
  all: async (sql: string, ...params: unknown[]) => {
    queries.push({ sql, params });
    const selected = sql.slice(sql.indexOf("SELECT") + 6, sql.indexOf("FROM")).split(",").map((c) => c.trim());
    // First page: (cutoff, limit). Later pages: (cutoff, count, id, limit).
    const [cutoff, ...rest] = params as number[];
    const limit = rest.pop()!;
    const cursor = rest.length === 2 ? { count: rest[0], id: rest[1] } : null;
    return users
      .filter((u) => u.streak_count > 0 && u.streak_last_activity_at >= cutoff && !u.suspended)
      .filter((u) => !cursor || u.streak_count < cursor.count || (u.streak_count === cursor.count && u.id < cursor.id))
      .sort((a, b) => b.streak_count - a.streak_count || b.id - a.id)
      .slice(0, limit)
      .map((u) => {
        const full: Record<string, unknown> = {
          ...u,
          streak_longest: u.streak_count,
          streak_last_counted_date: "2026-10-27",
          streak_started_at: 0,
          time_zone: u.time_zone ?? "America/New_York",
          country: u.country ?? null,
          latitude: u.latitude ?? null,
          longitude: u.longitude ?? null,
        };
        return Object.fromEntries(selected.map((column) => [column, full[column]]));
      });
  },
}));
vi.mock("@/server/env", () => ({ cfEnv: () => ({ LEADERBOARD_CACHE_SECONDS: cacheSeconds }) }));
// The real calendar and place logic run; only the Cloudflare runtime they import is stubbed.
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({}) }));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A Wednesday with no Shabbat or Yom Tov nearby, so a streak is alive for exactly 30 hours.
const NOW = Date.parse("2026-10-28T16:00:00Z");

const user = (id: number, streak: number, hoursAgo: number, extra: Partial<FakeUser> = {}): FakeUser => ({
  id,
  username: `user${id}`,
  streak_count: streak,
  streak_last_activity_at: NOW - hoursAgo * HOUR,
  ...extra,
});

async function load() {
  vi.resetModules(); // each test starts with an empty cache
  return import("@/server/leaderboard");
}

const viewer = (streak: number, id = 9_999) => ({ id, username: id === 9_999 ? "me" : `user${id}`, streak });

beforeEach(() => {
  users = [];
  queries.length = 0;
  cacheSeconds = undefined;
});

describe("reading the board", () => {
  it("lists live streaks longest first, without lapsed, suspended or very old ones", async () => {
    users = [
      user(1, 10, 5),
      user(2, 30, 29), // just inside the 30 hours
      user(3, 99, 31), // 31 hours: a weekday, so over
      user(4, 99, 165), // 6.9 days: over, however the calendar falls
      user(5, 99, 24 * 20), // older than any deadline can reach: never even read
      user(6, 77, 1, { suspended: true }),
      user(7, 20, 12),
      user(8, 0, 1),
    ];
    const { leaderboardFor } = await load();
    const board = await leaderboardFor(viewer(0), 10, NOW);
    expect(board.top.map((r) => [r.username, r.days])).toEqual([
      ["user2", 30],
      ["user7", 20],
      ["user1", 10],
    ]);
    expect(board.total).toBe(3);
    // The cut-off passed to the database is exactly the shared bound.
    expect(queries[0].params[0]).toBe(NOW - 7 * DAY);
  });

  describe("keeps members who observe Shabbat and Yom Tov on the board, using where they are", () => {
    // Checked in Friday 10 AM in New York. 30 hours on is Saturday afternoon, in the middle of Shabbat.
    const friday = Date.parse("2026-10-30T14:00:00Z");
    const sundayEarly = Date.parse("2026-11-01T09:00:00Z"); // 04:00 New York, 43 hours on
    const sundayLate = Date.parse("2026-11-01T14:00:00Z"); // 09:00 New York: more than 12 hours after Shabbat
    const ny = { latitude: 40.71, longitude: -74.0 };

    const row = (id: number, extra: Partial<FakeUser> = {}): FakeUser => ({
      id,
      username: `user${id}`,
      streak_count: 20,
      streak_last_activity_at: friday,
      ...extra,
    });
    const onBoardAt = async (now: number, ...rows: FakeUser[]) => {
      users = rows;
      const { leaderboardFor } = await load();
      return (await leaderboardFor(viewer(0), 10, now)).top.map((r) => r.username);
    };

    it("still on after Shabbat, and off once the 12 hours after it have passed", async () => {
      expect(sundayEarly - friday).toBeGreaterThan(30 * HOUR); // a plain 30-hour rule would have dropped them
      expect(await onBoardAt(sundayEarly, row(1, ny))).toEqual(["user1"]);
      expect(await onBoardAt(sundayLate, row(1, ny))).toEqual([]);
    });

    it("the same when the place is unknown (the cautious whole-day window)", async () => {
      // Shabbat is assumed to run until 3 AM Sunday, so the deadline is Sunday 15:00 New York time.
      expect(await onBoardAt(sundayEarly, row(1))).toEqual(["user1"]);
      expect(await onBoardAt(Date.parse("2026-11-01T19:00:00Z"), row(1))).toEqual(["user1"]); // 14:00
      expect(await onBoardAt(Date.parse("2026-11-01T21:00:00Z"), row(1))).toEqual([]); // 16:00
    });

    it("reads each member's own time zone, country and coordinates from their row", async () => {
      // Shemini Atzeret 2026 is one day in Israel and two in the Diaspora, so the same Friday check-in
      // lasts about a day longer in New York. The engine is the oracle; this checks the row reaches it.
      const { computeDeadline } = await import("@/lib/streak/engine");
      const { streakCalendar } = await import("@/lib/streak/calendar");
      const checkIn = { new_york: Date.parse("2026-10-02T14:00:00Z"), jerusalem: Date.parse("2026-10-02T07:00:00Z") };
      const places = {
        new_york: { timeZone: "America/New_York", israel: false, latitude: 40.71, longitude: -74.0 },
        jerusalem: { timeZone: "Asia/Jerusalem", israel: true, latitude: 31.77, longitude: 35.21 },
      };
      const deadline = {
        new_york: computeDeadline(checkIn.new_york, streakCalendar(places.new_york)).deadline,
        jerusalem: computeDeadline(checkIn.jerusalem, streakCalendar(places.jerusalem)).deadline,
      };
      expect(deadline.new_york - deadline.jerusalem).toBeGreaterThan(24 * HOUR); // the scenario means something

      const members = [
        row(1, { streak_last_activity_at: checkIn.new_york, time_zone: "America/New_York", country: "US", ...ny }),
        row(2, { streak_last_activity_at: checkIn.jerusalem, time_zone: "Asia/Jerusalem", country: "IL", latitude: 31.77, longitude: 35.21 }),
      ];
      expect(await onBoardAt(deadline.jerusalem - HOUR, ...members)).toEqual(["user1", "user2"]);
      expect(await onBoardAt(deadline.jerusalem + HOUR, ...members)).toEqual(["user1"]); // Israel's is over, New York's isn't
      expect(await onBoardAt(deadline.new_york + HOUR, ...members)).toEqual([]);
    });
  });

  it("never asks for passwords, emails, phone numbers or whole rows", async () => {
    users = [user(1, 5, 1)];
    const { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    const sql = queries[0].sql;
    expect(sql).not.toMatch(/\*/);
    for (const column of ["password_hash", "email", "phone", "first_name", "last_name", "totp", "webauthn", "admin_note"]) {
      expect(sql, column).not.toContain(column);
    }
    for (const column of LEADERBOARD_COLUMNS) expect(sql).toContain(column);
  });

  it("stops reading once it has enough live streaks, and then only claims a rank it is sure of", async () => {
    users = Array.from({ length: 450 }, (_, i) => user(i + 1, 1000 - i, 1)); // everyone alive
    const { leaderboardFor } = await load();
    const near = await leaderboardFor(viewer(900), 10, NOW);
    expect(queries).toHaveLength(1); // 200 rows were plenty
    expect(near.you).toMatchObject({ rank: 101, atLeast: false }); // 100 people have more than 900 days
    const far = await leaderboardFor(viewer(5), 10, NOW);
    expect(far.you).toMatchObject({ atLeast: true });
    expect(far.total).toBeNull();
    expect(far.top.map((r) => r.days)).toEqual([1000, 999, 998, 997, 996, 995, 994, 993, 992, 991]);
  });

  it("reads on past lapsed accounts with long old streaks instead of showing a short board", async () => {
    // 250 people with big streaks have just let them lapse; 60 with smaller ones are alive.
    users = [
      ...Array.from({ length: 250 }, (_, i) => user(i + 1, 900 - i, 165)),
      ...Array.from({ length: 60 }, (_, i) => user(1000 + i, 50 - (i % 40), 3)),
    ];
    const { leaderboardFor } = await load();
    const board = await leaderboardFor(viewer(0), 10, NOW);
    expect(queries).toHaveLength(2);
    expect(board.top).toHaveLength(10);
    expect(board.top[0]).toMatchObject({ days: 50, rank: 1 });
    expect(board.total).toBe(60);
  });

  it("pages with a cursor, so no one is skipped or repeated where a page ends in the middle of equal streaks", async () => {
    // 500 people on the same streak, nine in ten of them lapsed, so it keeps reading until the table runs out.
    users = Array.from({ length: 500 }, (_, i) => user(i + 1, 7, (i + 1) % 10 === 0 ? 2 : 165));
    const { leaderboardFor } = await load();
    // (Three pages is the most it will read, which covers 600 rows.)
    const board = await leaderboardFor(viewer(0), 500, NOW);
    expect(queries).toHaveLength(3); // 200 + 200 + 100 rows
    const alive = users.filter((u) => u.id % 10 === 0).map((u) => u.username).sort();
    expect(board.top.map((r) => r.username).sort()).toEqual(alive);
    expect(board.total).toBe(50);
  });

  it("gives up after a few pages rather than reading the whole table", async () => {
    users = Array.from({ length: 1500 }, (_, i) => user(i + 1, 5000 - i, 165)); // all lapsed
    const { leaderboardFor } = await load();
    const board = await leaderboardFor(viewer(3), 10, NOW);
    expect(queries).toHaveLength(3);
    // The rows it never reached might still hold live streaks, so rank 1 is only a lower bound.
    expect(board.you).toMatchObject({ rank: 1, atLeast: true });
    expect(board.total).toBeNull();
  });

  it("shows the viewer's current streak even though the shared read is older", async () => {
    users = [user(1, 12, 1), user(2, 12, 1)];
    const { leaderboardFor } = await load();
    const first = await leaderboardFor(viewer(12, 2), 10, NOW);
    expect(first.you).toMatchObject({ rank: 1, tied: true });
    const second = await leaderboardFor(viewer(13, 2), 10, NOW + 5_000); // served from the cache
    expect(queries).toHaveLength(1);
    expect(second.top.map((r) => [r.username, r.days, r.rank])).toEqual([
      ["user2", 13, 1],
      ["user1", 12, 2],
    ]);
  });
});

describe("the cache", () => {
  beforeEach(() => {
    users = [user(1, 5, 1)];
  });

  it("is reused for five minutes, then read again", async () => {
    const { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    await leaderboardFor(viewer(1), 10, NOW + 299_999);
    expect(queries).toHaveLength(1);
    await leaderboardFor(viewer(1), 10, NOW + 300_000);
    expect(queries).toHaveLength(2);
  });

  it("can be switched off (the end-to-end tests do) or tuned, whether set as text or as a number", async () => {
    for (const off of ["0", 0]) {
      queries.length = 0;
      cacheSeconds = off;
      const { leaderboardFor } = await load();
      await leaderboardFor(viewer(1), 10, NOW);
      await leaderboardFor(viewer(1), 10, NOW);
      await leaderboardFor(viewer(1), 10, NOW + 1);
      expect(queries, `${typeof off} ${off}`).toHaveLength(3);
    }
    for (const sixty of ["60", 60]) {
      queries.length = 0;
      cacheSeconds = sixty;
      const { leaderboardFor } = await load();
      await leaderboardFor(viewer(1), 10, NOW);
      await leaderboardFor(viewer(1), 10, NOW + 59_000);
      expect(queries, `${typeof sixty} ${sixty}`).toHaveLength(1);
      await leaderboardFor(viewer(1), 10, NOW + 60_000);
      expect(queries, `${typeof sixty} ${sixty}`).toHaveLength(2);
    }
  });

  it("falls back to the default for nonsense", async () => {
    for (const bad of ["abc", "-5", " ", "NaN", -1, Number.NaN]) {
      queries.length = 0;
      cacheSeconds = bad;
      const { leaderboardFor } = await load();
      await leaderboardFor(viewer(1), 10, NOW);
      await leaderboardFor(viewer(1), 10, NOW + 30_000);
      expect(queries, String(bad)).toHaveLength(1);
    }
  });

  it("is not trusted if the clock goes backwards", async () => {
    const { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    await leaderboardFor(viewer(1), 10, NOW - 1);
    expect(queries).toHaveLength(2);
  });
});
