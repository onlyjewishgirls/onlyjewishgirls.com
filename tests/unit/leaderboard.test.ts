import { describe, expect, it } from "vitest";
import { streakCalendar, type Place } from "@/lib/streak/calendar";
import {
  STREAK_CERTAINLY_OVER_MS,
  STREAK_WINDOW_HOURS,
  computeDeadline,
  getStreakStatus,
  type StreakState,
} from "@/lib/streak/engine";
import { buildBoard, compareEntries, describeStanding, type BoardEntry, type LiveBoard } from "@/lib/streak/leaderboard";
import { isStreakLive } from "@/lib/streak/live";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t = (iso: string) => Date.parse(iso);

const entry = (id: number, username: string, count: number): BoardEntry => ({ id, username, count });
const live = (entries: BoardEntry[], extra: Partial<LiveBoard> = {}): LiveBoard => ({
  entries: [...entries].sort(compareEntries),
  complete: true,
  floor: 0,
  ...extra,
});

describe("ranking", () => {
  it("puts the longest streak first and breaks ties by username, then id", () => {
    const sorted = [entry(3, "zed", 5), entry(2, "Amy", 5), entry(1, "bob", 9), entry(4, "amy", 5)].sort(compareEntries);
    expect(sorted.map((e) => e.id)).toEqual([1, 2, 4, 3]); // bob (9), then Amy / amy (5, by id), then zed
  });

  it("sorts equal streaks by username ignoring case, then by id", () => {
    const sorted = [entry(1, "bob", 5), entry(2, "Alice", 5), entry(3, "carol", 5), entry(4, "ALICE", 5), entry(5, "Bob", 5)].sort(
      compareEntries,
    );
    expect(sorted.map((e) => e.id)).toEqual([2, 4, 1, 5, 3]); // Alice, ALICE, bob, Bob (by id), carol
  });

  it("gives equal streaks the same rank and skips the ranks they use up", () => {
    const board = buildBoard(
      live([entry(1, "a", 30), entry(2, "b", 20), entry(3, "c", 20), entry(4, "d", 10)]),
      entry(9, "me", 5),
      10,
    );
    expect(board.top.map((r) => [r.username, r.rank])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 2],
      ["d", 4],
      ["me", 5],
    ]);
  });

  it("limits the list but still tells the viewer where they are", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(i + 1, `u${String(i).padStart(2, "0")}`, 100 - i));
    const board = buildBoard(live(entries), entry(99, "me", 40), 10);
    expect(board.top).toHaveLength(10);
    expect(board.youInTop).toBe(false);
    expect(board.you).toMatchObject({ username: "me", rank: 31, days: 40, you: true });
    expect(board.total).toBe(31);
  });

  it("marks the viewer's row when they are in the list", () => {
    const board = buildBoard(live([entry(1, "a", 30), entry(2, "me", 20)]), entry(2, "me", 20), 10);
    expect(board.youInTop).toBe(true);
    expect(board.top.filter((r) => r.you).map((r) => r.username)).toEqual(["me"]);
  });

  it("uses the viewer's current streak, not the possibly minute-old one in the shared read", () => {
    // The shared read has `me` at 12; they have just checked in and reached 13, passing `b`.
    const shared = live([entry(1, "a", 20), entry(2, "me", 12), entry(3, "b", 12)]);
    const board = buildBoard(shared, entry(2, "me", 13), 10);
    expect(board.top.map((r) => [r.username, r.days, r.rank])).toEqual([
      ["a", 20, 1],
      ["me", 13, 2],
      ["b", 12, 3],
    ]);
    expect(board.top.filter((r) => r.username === "me")).toHaveLength(1); // never listed twice
  });

  it("adds a viewer who isn't in the shared read yet (a brand-new streak)", () => {
    const board = buildBoard(live([entry(1, "a", 3)]), entry(2, "new", 1), 10);
    expect(board.top.map((r) => r.username)).toEqual(["a", "new"]);
    expect(board.you).toMatchObject({ rank: 2, days: 1 });
  });

  it("leaves a viewer with no streak off the board", () => {
    const board = buildBoard(live([entry(1, "a", 3), entry(2, "lapsed", 8)]), entry(2, "lapsed", 0), 10);
    expect(board.you).toBeNull();
    expect(board.youInTop).toBe(false);
    expect(board.top.map((r) => r.username)).toEqual(["a"]);
  });

  it("copes with an empty board", () => {
    const board = buildBoard(live([]), entry(1, "me", 0), 10);
    expect(board).toEqual({ top: [], you: null, youInTop: false, total: 0 });
  });

  it("only exposes what a page shows: exactly the rank, username, days and who you are", () => {
    const board = buildBoard(live([entry(7, "a", 3)]), entry(8, "me", 2), 10);
    for (const row of board.top) expect(Object.keys(row).sort()).toEqual(["days", "rank", "username", "you"]);
    expect(Object.keys(board.you!).sort()).toEqual(["atLeast", "days", "rank", "tied", "username", "you"]);
    expect(Object.keys(board).sort()).toEqual(["top", "total", "you", "youInTop"]);
  });

  describe("when the database read stopped early", () => {
    // Everyone with a streak above 10 days was read; anyone not read has 10 days or fewer.
    const partial = live([entry(1, "a", 50), entry(2, "b", 30), entry(3, "c", 12)], { complete: false, floor: 10 });

    it("is exact for a viewer above the cut-off", () => {
      const board = buildBoard(partial, entry(9, "me", 11), 10);
      expect(board.you).toMatchObject({ rank: 4, atLeast: false });
    });

    it("is exact for a viewer exactly at it (everyone ahead has a longer streak)", () => {
      const board = buildBoard(partial, entry(9, "me", 10), 10);
      expect(board.you).toMatchObject({ rank: 4, atLeast: false });
    });

    it("gives only a lower bound below it, and no total", () => {
      const board = buildBoard(partial, entry(9, "me", 4), 10);
      expect(board.you).toMatchObject({ rank: 4, atLeast: true });
      expect(board.total).toBeNull();
    });
  });
});

describe("what the board says about the viewer", () => {
  const stand = (live_: LiveBoard, viewer: BoardEntry) => {
    const board = buildBoard(live_, viewer, 10);
    return describeStanding(board.you, board.total);
  };

  it("reads naturally", () => {
    const others = [entry(1, "a", 30), entry(2, "b", 20), entry(3, "c", 10)];
    expect(stand(live(others), entry(9, "me", 40))).toBe("You're #1 with a 40-day streak! 👑");
    expect(stand(live(others), entry(9, "me", 15))).toBe("You're #3 of 4 live streaks with a 15-day streak.");
    expect(stand(live(others), entry(9, "me", 20))).toBe("You're tied for #2 with a 20-day streak.");
    expect(stand(live(others), entry(9, "me", 1))).toBe("You're #4 of 4 live streaks with a 1-day streak.");
    expect(stand(live(others, { complete: false, floor: 10 }), entry(9, "me", 3))).toBe("You're ranked #4+ with a 3-day streak.");
    expect(stand(live(others), entry(9, "me", 0))).toBe("Check in to start a streak and join the leaderboard.");
  });

  it("calls a lone leader tied only when someone really has the same streak", () => {
    expect(stand(live([]), entry(9, "me", 5))).toBe("You're #1 with a 5-day streak! 👑");
    expect(stand(live([entry(1, "a", 5)]), entry(9, "me", 5))).toBe("You're tied for #1 with a 5-day streak.");
  });
});

describe("who is on the board", () => {
  const NY: Place = { timeZone: "America/New_York", israel: false, latitude: 40.7128, longitude: -74.006 };
  const NY_UNKNOWN: Place = { ...NY, latitude: null, longitude: null };
  const state = (lastActivityAt: number | null, count = 12): StreakState => ({
    count,
    longest: count,
    lastActivityAt,
    lastCountedDate: "2026-10-30",
    startedAt: 0,
  });

  it("includes anyone who checked in within 30 hours, and drops them just after", () => {
    const last = t("2026-10-27T15:00:00Z"); // a Tuesday: no Shabbat or Yom Tov nearby
    expect(isStreakLive(state(last), NY, last + STREAK_WINDOW_HOURS * HOUR)).toBe(true);
    expect(isStreakLive(state(last), NY, last + STREAK_WINDOW_HOURS * HOUR + 1)).toBe(false);
  });

  it("keeps Shabbat-observant members on: the deadline moves to 12 hours after Shabbat ends", () => {
    const friday = t("2026-10-30T14:00:00Z"); // 10 AM in New York; 30 hours later is Saturday afternoon
    const deadline = computeDeadline(friday, streakCalendar(NY)).deadline;
    expect(deadline).toBeGreaterThan(friday + 40 * HOUR);
    // Sunday 04:00 New York time (the clocks went back that night): 43 hours on, but still alive.
    expect(isStreakLive(state(friday), NY, t("2026-11-01T09:00:00Z"))).toBe(true);
    // Sunday 09:00: past the 12 hours.
    expect(isStreakLive(state(friday), NY, t("2026-11-01T14:00:00Z"))).toBe(false);
  });

  it("uses the cautious whole-day Shabbat when the place is unknown", () => {
    const friday = t("2026-10-30T14:00:00Z");
    // Shabbat is assumed to run from noon on Friday to 3 AM on Sunday, so the deadline is Sunday 15:00.
    expect(isStreakLive(state(friday), NY_UNKNOWN, t("2026-11-01T19:00:00Z"))).toBe(true); // Sunday 14:00
    expect(isStreakLive(state(friday), NY_UNKNOWN, t("2026-11-01T21:00:00Z"))).toBe(false); // Sunday 16:00
  });

  it("is never on the board without a streak or a check-in", () => {
    const now = t("2026-10-30T14:00:00Z");
    expect(isStreakLive(state(now, 0), NY, now)).toBe(false);
    expect(isStreakLive(state(null, 5), NY, now)).toBe(false);
  });

  it("always agrees with the streak rules (the 30-hour shortcut never changes an answer)", () => {
    const places: Place[] = [
      NY,
      NY_UNKNOWN,
      { timeZone: "Asia/Jerusalem", israel: true, latitude: 31.7683, longitude: 35.2137 },
      { timeZone: "Australia/Melbourne", israel: false, latitude: -37.8136, longitude: 144.9631 },
      { timeZone: "Europe/Oslo", israel: false, latitude: 69.6492, longitude: 18.9553 },
    ];
    const gaps = [0, 1, 12 * HOUR, 29 * HOUR, 30 * HOUR - 1, 30 * HOUR, 30 * HOUR + 1, 31 * HOUR, 42 * HOUR, 2 * DAY, 3 * DAY, 4 * DAY, 5 * DAY, 6 * DAY, 6.5 * DAY, 7 * DAY];
    let checked = 0;
    for (const place of places) {
      const calendar = streakCalendar(place);
      // Every 5 hours across the Tishrei holidays, Pesach and an ordinary stretch.
      for (const [from, to] of [["2026-09-10", "2026-10-12"], ["2027-03-18", "2027-04-30"], ["2026-11-15", "2026-11-30"]]) {
        for (let last = t(`${from}T00:00:00Z`); last < t(`${to}T00:00:00Z`); last += 5 * HOUR) {
          for (const gap of gaps) {
            const s = state(last);
            expect(isStreakLive(s, place, last + gap), `${place.timeZone} ${new Date(last).toISOString()} +${gap}`).toBe(
              getStreakStatus(s, last + gap, calendar).alive,
            );
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe("how long a streak can last without a check-in", () => {
  it("is never longer than the cut-off the leaderboard and admin panel use to skip old streaks", () => {
    // Every place type, every 3 hours for six years: Rosh Hashana to Simchat Torah, Pesach, Shavuot, every Shabbat.
    const places: Record<string, Place> = {
      "New York": { timeZone: "America/New_York", israel: false, latitude: 40.7128, longitude: -74.006 },
      Jerusalem: { timeZone: "Asia/Jerusalem", israel: true, latitude: 31.7683, longitude: 35.2137 },
      Melbourne: { timeZone: "Australia/Melbourne", israel: false, latitude: -37.8136, longitude: 144.9631 },
      "Tromsø (polar)": { timeZone: "Europe/Oslo", israel: false, latitude: 69.6492, longitude: 18.9553 },
      "unknown, diaspora": { timeZone: "America/Chicago", israel: false, latitude: null, longitude: null },
      "unknown, Israel": { timeZone: "Asia/Jerusalem", israel: true, latitude: null, longitude: null },
    };
    const start = t("2026-01-01T00:00:00Z");
    const end = t("2032-01-01T00:00:00Z");
    for (const [name, place] of Object.entries(places)) {
      const calendar = streakCalendar(place);
      let longest = 0;
      let shortest = Infinity;
      for (let last = start; last < end; last += 3 * HOUR) {
        const span = computeDeadline(last, calendar).deadline - last;
        longest = Math.max(longest, span);
        shortest = Math.min(shortest, span);
      }
      // Never earlier than the plain window: the reason a recent check-in needs no calendar lookup.
      expect(shortest, name).toBeGreaterThanOrEqual(STREAK_WINDOW_HOURS * HOUR);
      expect(longest, name).toBeLessThan(STREAK_CERTAINLY_OVER_MS);
    }
  }, 120_000);

  it("is 6.4 days at the very most, in the one case where holy days chain together", () => {
    // Pesach 2026 with the place unknown: Wed-Thu Yom Tov, one ordinary day, then Shabbat, all assumed
    // to run from noon on Erev to 3 AM after. A check-in on Monday morning lasts until the following Sunday.
    const place: Place = { timeZone: "America/New_York", israel: false, latitude: null, longitude: null };
    const monday = t("2026-04-06T10:00:00Z");
    const span = computeDeadline(monday, streakCalendar(place)).deadline - monday;
    expect(span / DAY).toBeGreaterThan(6);
    expect(span).toBeLessThan(STREAK_CERTAINLY_OVER_MS);
  });
});
