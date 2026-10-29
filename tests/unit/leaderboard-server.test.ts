import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the users table, answering the leaderboard's query the way SQLite would.
interface FakeUser {
  id: number;
  username: string;
  streak_count: number;
  streak_last_activity_at: number;
  suspended?: boolean;
}
let users: FakeUser[] = [];
let cacheSeconds: string | undefined;
const queries: { sql: string; params: unknown[] }[] = [];

vi.mock("@/server/db", () => ({
  all: async (sql: string, ...params: unknown[]) => {
    queries.push({ sql, params });
    const [cutoff, cursorCount, , , cursorId, limit] = params as [number, number | null, number, number, number | null, number];
    return users
      .filter((u) => u.streak_count > 0 && u.streak_last_activity_at >= cutoff && !u.suspended)
      .filter((u) => cursorCount === null || u.streak_count < cursorCount || (u.streak_count === cursorCount && u.id < cursorId!))
      .sort((a, b) => b.streak_count - a.streak_count || b.id - a.id)
      .slice(0, limit)
      .map((u) => ({
        ...u,
        streak_longest: u.streak_count,
        streak_last_counted_date: "2026-10-27",
        streak_started_at: 0,
        time_zone: "America/New_York",
        country: null,
        latitude: null,
        longitude: null,
      }));
  },
}));
vi.mock("@/server/env", () => ({ cfEnv: () => ({ LEADERBOARD_CACHE_SECONDS: cacheSeconds }) }));
vi.mock("@/server/location", () => ({
  storedPlace: (u: { timeZone: string; latitude: number | null; longitude: number | null }) => ({
    timeZone: u.timeZone,
    israel: false,
    latitude: u.latitude,
    longitude: u.longitude,
  }),
}));

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

  it("never asks for passwords, emails, phone numbers or whole rows", async () => {
    users = [user(1, 5, 1)];
    const { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    const sql = queries[0].sql;
    expect(sql).not.toMatch(/\*/);
    for (const column of ["password_hash", "email", "phone", "first_name", "last_name", "totp", "webauthn", "admin_note"]) {
      expect(sql, column).not.toContain(column);
    }
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
    const board = await leaderboardFor(viewer(0), 500, NOW);
    expect(queries).toHaveLength(3); // 200 + 200 + 100 rows
    const alive = users.filter((u) => (u.id % 10) === 0).map((u) => u.username).sort();
    expect(board.top.map((r) => r.username).sort()).toEqual(alive);
    expect(board.total).toBe(50);
  });

  it("gives up after a few pages rather than reading the whole table", async () => {
    users = Array.from({ length: 1500 }, (_, i) => user(i + 1, 5000 - i, 165)); // all lapsed
    const { leaderboardFor } = await load();
    const board = await leaderboardFor(viewer(3), 10, NOW);
    expect(queries).toHaveLength(5);
    // The 500 rows it never reached might still hold live streaks, so rank 1 is only a lower bound.
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

  it("is reused for a minute, then read again", async () => {
    const { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    await leaderboardFor(viewer(1), 10, NOW + 59_999);
    expect(queries).toHaveLength(1);
    await leaderboardFor(viewer(1), 10, NOW + 60_000);
    expect(queries).toHaveLength(2);
  });

  it("can be switched off (the end-to-end tests do) or tuned, and ignores nonsense", async () => {
    cacheSeconds = "0";
    let { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    await leaderboardFor(viewer(1), 10, NOW);
    expect(queries).toHaveLength(2);

    queries.length = 0;
    cacheSeconds = "300";
    ({ leaderboardFor } = await load());
    await leaderboardFor(viewer(1), 10, NOW);
    await leaderboardFor(viewer(1), 10, NOW + 299_000);
    expect(queries).toHaveLength(1);

    for (const bad of ["abc", "-5", " ", "NaN"]) {
      queries.length = 0;
      cacheSeconds = bad;
      ({ leaderboardFor } = await load());
      await leaderboardFor(viewer(1), 10, NOW);
      await leaderboardFor(viewer(1), 10, NOW + 30_000);
      expect(queries, bad).toHaveLength(1); // fell back to the one-minute default
    }
  });

  it("is not trusted if the clock goes backwards", async () => {
    const { leaderboardFor } = await load();
    await leaderboardFor(viewer(1), 10, NOW);
    await leaderboardFor(viewer(1), 10, NOW - 1);
    expect(queries).toHaveLength(2);
  });
});
