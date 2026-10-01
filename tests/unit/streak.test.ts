import { describe, expect, it } from "vitest";
import {
  holyDayNames,
  holyPeriods,
  observesIsraelSchedule,
  streakCalendar,
  type Place,
} from "@/lib/streak/calendar";
import { addDays, daysBetween, localDate, zonedTime } from "@/lib/streak/dates";
import {
  AFTER_HOLY_DAY_HOURS,
  EMPTY_STREAK,
  STREAK_WINDOW_HOURS,
  computeDeadline,
  getStreakStatus,
  recordActivity,
  type StreakState,
} from "@/lib/streak/engine";

const HOUR = 3_600_000;
const t = (iso: string) => Date.parse(iso);

const NY: Place = { timeZone: "America/New_York", israel: false, latitude: 40.7128, longitude: -74.006 };
const JERUSALEM: Place = { timeZone: "Asia/Jerusalem", israel: true, latitude: 31.7683, longitude: 35.2137 };
const PLACES: Record<string, Place> = {
  "New York": NY,
  Jerusalem: JERUSALEM,
  London: { timeZone: "Europe/London", israel: false, latitude: 51.5074, longitude: -0.1278 },
  Melbourne: { timeZone: "Australia/Melbourne", israel: false, latitude: -37.8136, longitude: 144.9631 },
  "Los Angeles": { timeZone: "America/Los_Angeles", israel: false, latitude: 34.0522, longitude: -118.2437 },
  "Tromsø (no sunset in summer, none in winter)": {
    timeZone: "Europe/Oslo",
    israel: false,
    latitude: 69.6492,
    longitude: 18.9553,
  },
  "unknown location": { timeZone: "America/Chicago", israel: false, latitude: null, longitude: null },
};

const ny = streakCalendar(NY);
const localHour = (instant: number, timeZone: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(instant));

function streakAt(count: number, lastActivity: string, timeZone = NY.timeZone): StreakState {
  const at = t(lastActivity);
  return { count, longest: count, lastActivityAt: at, lastCountedDate: localDate(at, timeZone), startedAt: at };
}

describe("date helpers", () => {
  it("reads calendar dates in the user's time zone", () => {
    expect(localDate(t("2026-10-02T03:30:00Z"), "America/New_York")).toBe("2026-10-01");
    expect(localDate(t("2026-10-02T03:30:00Z"), "Asia/Jerusalem")).toBe("2026-10-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2027-04-21", "2027-04-24")).toBe(3);
  });

  it("converts local wall-clock times to instants, across daylight saving changes", () => {
    expect(zonedTime("2026-10-02", 12, 0, "America/New_York")).toBe(t("2026-10-02T12:00:00-04:00"));
    expect(zonedTime("2026-11-02", 12, 0, "America/New_York")).toBe(t("2026-11-02T12:00:00-05:00"));
    expect(zonedTime("2026-10-02", 3, 0, "Asia/Jerusalem")).toBe(t("2026-10-02T03:00:00+03:00"));
  });
});

describe("Shabbat & Yom Tov calendar", () => {
  it("knows every Shabbat", () => {
    expect(holyDayNames("2026-10-24", false)).toEqual(["Shabbat"]);
    expect(holyDayNames("2026-10-23", false)).toEqual([]);
  });

  it("keeps two days of Yom Tov in the diaspora and one in Israel", () => {
    expect(holyDayNames("2027-04-23", false)).toEqual(["Pesach II"]);
    expect(holyDayNames("2027-04-23", true)).toEqual([]);
    expect(holyDayNames("2026-10-04", false)).toEqual(["Simchat Torah"]);
    expect(holyDayNames("2026-10-04", true)).toEqual([]);
  });

  it("treats Chol HaMoed as a regular day and Yom Kippur as Yom Tov", () => {
    expect(holyDayNames("2026-09-29", false)).toEqual([]);
    expect(holyDayNames("2026-09-21", false)).toEqual(["Yom Kippur"]);
  });

  it("uses the Israel schedule for users in Israel", () => {
    expect(observesIsraelSchedule("Asia/Jerusalem")).toBe(true);
    expect(observesIsraelSchedule("Europe/Paris", "IL")).toBe(true);
    expect(observesIsraelSchedule("America/New_York", "US")).toBe(false);
  });

  it("runs Shabbat from 40 minutes before Friday's sunset to 72 minutes after Saturday's", () => {
    const [shabbat] = holyPeriods(NY, t("2026-10-23T08:00:00-04:00"), t("2026-10-23T09:00:00-04:00") + 48 * HOUR);
    expect(shabbat.dates).toEqual(["2026-10-24"]);
    // New York sunset is ~6:03 PM on Friday Oct 23 and ~6:02 PM on Saturday Oct 24.
    expect(shabbat.start).toBeGreaterThan(t("2026-10-23T17:15:00-04:00"));
    expect(shabbat.start).toBeLessThan(t("2026-10-23T17:35:00-04:00"));
    expect(shabbat.end).toBeGreaterThan(t("2026-10-24T19:05:00-04:00"));
    expect(shabbat.end).toBeLessThan(t("2026-10-24T19:25:00-04:00"));
  });

  it("joins Yom Tov and an adjoining Shabbat into one period", () => {
    const [pesach] = holyPeriods(NY, t("2027-04-21T12:00:00-04:00"), t("2027-04-21T23:00:00-04:00"));
    expect(pesach.dates).toEqual(["2027-04-22", "2027-04-23", "2027-04-24"]);
    expect(pesach.names).toEqual(expect.arrayContaining(["Pesach I", "Pesach II", "Shabbat"]));
  });

  it("falls back to noon on Erev until 3 AM afterwards when the location is unknown", () => {
    const place = PLACES["unknown location"];
    const [shabbat] = holyPeriods(place, t("2026-10-23T08:00:00-05:00"), t("2026-10-23T13:00:00-05:00"));
    expect(shabbat.start).toBe(zonedTime("2026-10-23", 12, 0, place.timeZone));
    expect(shabbat.end).toBe(zonedTime("2026-10-25", 3, 0, place.timeZone));
  });

  it("falls back the same way where the sun doesn't set", () => {
    const place = PLACES["Tromsø (no sunset in summer, none in winter)"];
    const [shabbat] = holyPeriods(place, t("2026-06-19T08:00:00+02:00"), t("2026-06-19T13:00:00+02:00"));
    expect(shabbat.start).toBe(zonedTime("2026-06-19", 12, 0, place.timeZone));
    expect(shabbat.end).toBe(zonedTime("2026-06-21", 3, 0, place.timeZone));
  });
});

describe("streak deadline", () => {
  it("is 30 hours after the last check-in on a regular weekday", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-19T10:00:00-04:00"), ny);
    expect(deadline).toBe(t("2026-10-20T16:00:00-04:00"));
    expect(leeway).toEqual([]);
  });

  it("stays put when 30 hours ends before Shabbat starts — check in on Friday", () => {
    const { deadline } = computeDeadline(t("2026-10-22T09:00:00-04:00"), ny);
    expect(deadline).toBe(t("2026-10-23T15:00:00-04:00"));
  });

  it("moves past Shabbat, to 12 hours after it ends, when Shabbat comes within the window", () => {
    // Thursday night (30h ends mid-Shabbat), Friday afternoon, and just after candle lighting.
    for (const lastCheckIn of ["2026-10-22T23:00:00-04:00", "2026-10-23T16:00:00-04:00", "2026-10-23T19:00:00-04:00"]) {
      const { deadline, leeway } = computeDeadline(t(lastCheckIn), ny);
      expect(leeway.map((p) => p.dates)).toEqual([["2026-10-24"]]);
      expect(deadline).toBe(leeway[0].end + AFTER_HOLY_DAY_HOURS * HOUR);
      expect(localDate(deadline, NY.timeZone)).toBe("2026-10-25"); // Sunday morning
    }
  });

  it("keeps the plain 30 hours when that is already later than 12 hours after Shabbat", () => {
    const last = t("2026-10-24T21:00:00-04:00"); // after Havdalah
    expect(computeDeadline(last, ny).deadline).toBe(last + STREAK_WINDOW_HOURS * HOUR);
  });

  it("covers a 2-day Yom Tov (Shmini Atzeret + Simchat Torah) in the diaspora", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-02T16:00:00-04:00"), ny);
    expect(leeway[0].dates).toEqual(["2026-10-03", "2026-10-04"]);
    expect(leeway[0].names).toEqual(expect.arrayContaining(["Shmini Atzeret", "Shabbat", "Simchat Torah"]));
    expect(localDate(deadline, NY.timeZone)).toBe("2026-10-05");
  });

  it("covers only one day in Israel, where Shmini Atzeret is one day", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-02T16:00:00+03:00"), streakCalendar(JERUSALEM));
    expect(leeway[0].dates).toEqual(["2026-10-03"]);
    expect(localDate(deadline, JERUSALEM.timeZone)).toBe("2026-10-04");
  });

  it("covers a 3-day Yom Tov (Pesach I, Pesach II, Shabbat)", () => {
    const { deadline, leeway } = computeDeadline(t("2027-04-21T16:00:00-04:00"), ny);
    expect(leeway[0].dates).toEqual(["2027-04-22", "2027-04-23", "2027-04-24"]);
    expect(deadline).toBe(leeway[0].end + AFTER_HOLY_DAY_HOURS * HOUR);
    expect(localDate(deadline, NY.timeZone)).toBe("2027-04-25");
  });

  it.each(Object.entries(PLACES))("never falls on Shabbat or Yom Tov in %s, all year", (_name, place) => {
    const calendar = streakCalendar(place);
    for (let last = t("2026-09-01T00:00:00Z"); last < t("2027-09-01T00:00:00Z"); last += 7 * HOUR) {
      const { deadline } = computeDeadline(last, calendar);
      expect(deadline).toBeGreaterThanOrEqual(last + STREAK_WINDOW_HOURS * HOUR);
      for (const period of holyPeriods(place, last, deadline + 1)) {
        expect(deadline < period.start || deadline >= period.end + AFTER_HOLY_DAY_HOURS * HOUR).toBe(true);
      }
    }
  });
});

describe("recording check-ins", () => {
  it("starts a streak at 1", () => {
    const r = recordActivity(EMPTY_STREAK, t("2026-10-19T10:00:00-04:00"), ny);
    expect(r.outcome).toBe("started");
    expect(r.state.count).toBe(1);
    expect(r.state.lastCountedDate).toBe("2026-10-19");
  });

  it("counts once per day but keeps pushing the deadline", () => {
    const first = recordActivity(EMPTY_STREAK, t("2026-10-19T08:00:00-04:00"), ny);
    const second = recordActivity(first.state, t("2026-10-19T23:00:00-04:00"), ny);
    expect(second.outcome).toBe("same-day");
    expect(second.state.count).toBe(1);
    expect(computeDeadline(second.state.lastActivityAt!, ny).deadline).toBe(t("2026-10-21T05:00:00-04:00"));
  });

  it("adds a day for each new day within 30 hours", () => {
    const r = recordActivity(streakAt(5, "2026-10-19T23:00:00-04:00"), t("2026-10-21T01:00:00-04:00"), ny);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(6);
  });

  it("keeps the streak over Shabbat and counts Shabbat", () => {
    const r = recordActivity(streakAt(10, "2026-10-23T16:00:00-04:00"), t("2026-10-24T20:30:00-04:00"), ny);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(11);
  });

  it("allows checking in on Sunday morning after Shabbat, crediting Shabbat", () => {
    const r = recordActivity(streakAt(10, "2026-10-23T16:00:00-04:00"), t("2026-10-25T06:30:00-04:00"), ny);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(12); // Shabbat + Sunday
  });

  it("breaks once the 12 hours after Shabbat have passed", () => {
    const r = recordActivity(streakAt(10, "2026-10-23T16:00:00-04:00"), t("2026-10-25T10:00:00-04:00"), ny);
    expect(r.outcome).toBe("restarted");
    expect(r.previousCount).toBe(10);
    expect(r.state.count).toBe(1);
    expect(r.state.longest).toBe(10);
  });

  it("survives a 2-day Yom Tov and counts both days", () => {
    const r = recordActivity(streakAt(30, "2026-10-02T16:00:00-04:00"), t("2026-10-04T20:30:00-04:00"), ny);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(32);
  });

  it("survives a 3-day Yom Tov and counts all three days", () => {
    const r = recordActivity(streakAt(30, "2027-04-21T16:00:00-04:00"), t("2027-04-24T21:15:00-04:00"), ny);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(33);
  });

  it("still requires a check-in when the 30 hours run out before Yom Tov starts", () => {
    // Tuesday morning + 30h = Wednesday 2 PM, before Pesach starts Wednesday evening.
    const r = recordActivity(streakAt(30, "2027-04-20T08:00:00-04:00"), t("2027-04-24T21:15:00-04:00"), ny);
    expect(r.outcome).toBe("restarted");
  });
});

describe("streak status", () => {
  it("shows the hourglass in the last 4 hours", () => {
    const state = streakAt(7, "2026-10-19T10:00:00-04:00");
    expect(getStreakStatus(state, t("2026-10-20T11:00:00-04:00"), ny).atRisk).toBe(false);
    const late = getStreakStatus(state, t("2026-10-20T13:00:00-04:00"), ny);
    expect(late.atRisk).toBe(true);
    expect(late.remainingMs).toBe(3 * HOUR);
    expect(late.count).toBe(7);
  });

  it("reports 0 once the deadline has passed", () => {
    const status = getStreakStatus(streakAt(7, "2026-10-19T10:00:00-04:00"), t("2026-10-20T16:00:01-04:00"), ny);
    expect(status.alive).toBe(false);
    expect(status.count).toBe(0);
    expect(status.longest).toBe(7);
  });

  it("explains which Shabbat or Yom Tov moved the deadline", () => {
    const status = getStreakStatus(streakAt(7, "2026-10-23T16:00:00-04:00"), t("2026-10-24T22:00:00-04:00"), ny);
    expect(status.leeway.map((p) => p.names)).toEqual([["Shabbat"]]);
    expect(localHour(status.deadline!, NY.timeZone)).toBeLessThan(10);
  });
});
