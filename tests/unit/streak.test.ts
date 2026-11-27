import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAK_RULES,
  HOUR_WINDOW_RULES,
  holyDayNames,
  holyPeriods,
  observesIsraelSchedule,
  restrictedNames,
  streakCalendar,
  type Place,
  type StreakRules,
} from "@/lib/streak/calendar";
import { addDays, daysBetween, localDate, startOfDay, validTimeZone, zonedTime } from "@/lib/streak/dates";
import {
  AFTER_HOLY_DAY_HOURS,
  EMPTY_STREAK,
  STREAK_WINDOW_HOURS,
  computeDeadline,
  getStreakStatus,
  nextRequiredDate,
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

// The hour-window tests below are the rule before weekend grace and whole days
// (both settings off), so they don't depend on which weekday they land on.
const OLD: StreakRules = HOUR_WINDOW_RULES;
const ny = streakCalendar(NY, OLD);
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

describe("streak deadline (hour window: weekend grace and whole days off)", () => {
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
    const { deadline, leeway } = computeDeadline(t("2026-10-02T16:00:00+03:00"), streakCalendar(JERUSALEM, OLD));
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
    const calendar = streakCalendar(place, OLD);
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

// ---- Weekend grace and whole days (PORTAL-STANDARD §4, the default) ----
// Ported from the shared streak.js test (streaktest.mjs, "weekend grace") onto
// this site's engine. Two conventions of this site carry over unchanged: names
// come from hebcal ("Shabbat", "Shmini Atzeret"), and a Shabbat or Yom Tov
// passed over still adds a day to the count. Skipped grace weekdays add nothing.

const nyNew = streakCalendar(NY, DEFAULT_STREAK_RULES);
const LA: Place = PLACES["Los Angeles"];

describe("weekend grace: Friday and Sunday", () => {
  it("are grace days, Monday is not, and a Yom Tov on a Friday is named as Yom Tov", () => {
    expect(restrictedNames("2026-11-20", false, true)).toEqual(["Friday"]);
    expect(restrictedNames("2026-11-22", false, true)).toEqual(["Sunday"]);
    expect(restrictedNames("2026-11-23", false, true)).toEqual([]);
    expect(restrictedNames("2026-11-21", false, true)).toEqual(["Shabbat"]);
    expect(restrictedNames("2026-04-03", false, true)).toEqual(["Pesach II"]);
  });

  it("can be turned off", () => {
    expect(restrictedNames("2026-11-20", false, false)).toEqual([]);
    expect(streakCalendar(NY, { weekendGrace: false, calendarDays: true }).restricted("2026-11-22")).toEqual([]);
  });

  it("the next required day after Thursday is Monday; after Monday, Tuesday", () => {
    expect(nextRequiredDate("2026-11-19", nyNew)).toBe("2026-11-23");
    expect(nextRequiredDate("2026-11-23", nyNew)).toBe("2026-11-24");
    expect(nextRequiredDate("2026-11-21", nyNew)).toBe("2026-11-23"); // Motzei Shabbat
  });

  it("a weekend is one block, from midnight Friday to midnight after Sunday", () => {
    const [weekend] = holyPeriods(NY, t("2026-11-19T12:00:00-05:00"), t("2026-11-19T13:00:00-05:00") + 30 * HOUR, true);
    expect(weekend.dates).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
    expect(weekend.names).toEqual(["Friday", "Shabbat", "Sunday"]);
    expect(weekend.start).toBe(t("2026-11-20T00:00:00-05:00"));
    expect(weekend.end).toBe(t("2026-11-23T00:00:00-05:00"));
  });
});

describe("whole days: any time Thursday, then any time Monday", () => {
  for (const [thu, mon] of [
    ["2026-11-19T00:01:00-05:00", "2026-11-23T23:59:00-05:00"], // earliest Thursday, latest Monday
    ["2026-11-19T23:59:00-05:00", "2026-11-23T00:01:00-05:00"],
    ["2026-11-19T12:00:00-05:00", "2026-11-23T18:00:00-05:00"],
  ]) {
    it(`Thursday ${thu.slice(11, 16)} then Monday ${mon.slice(11, 16)} keeps it`, () => {
      const r = recordActivity(streakAt(5, thu), t(mon), nyNew);
      expect(r.outcome).toBe("continued");
      expect(r.state.count).toBe(7); // Monday, plus Shabbat passed over
    });
  }

  it("the deadline is the last moment of Monday, naming Friday, Shabbat and Sunday", () => {
    const d = computeDeadline(t("2026-11-19T00:01:00-05:00"), nyNew);
    expect(d.dueDate).toBe("2026-11-23");
    expect(localDate(d.deadline, NY.timeZone)).toBe("2026-11-23");
    expect(localDate(d.deadline + 1, NY.timeZone)).toBe("2026-11-24");
    expect(d.leeway.flatMap((p) => p.names)).toEqual(["Friday", "Shabbat", "Sunday"]);
  });

  it("Tuesday is too late", () => {
    const r = recordActivity(streakAt(5, "2026-11-19T12:00:00-05:00"), t("2026-11-24T00:30:00-05:00"), nyNew);
    expect(r.outcome).toBe("restarted");
    expect(r.previousCount).toBe(5);
  });

  it("a weekday still needs the next weekday: Monday 00:05 then Tuesday 23:50 keeps it (a whole day, not 30 hours)", () => {
    const r = recordActivity(streakAt(5, "2026-11-23T00:05:00-05:00"), t("2026-11-24T23:50:00-05:00"), nyNew);
    expect(r.state.count).toBe(6);
  });

  it("Monday then Wednesday breaks it", () => {
    expect(recordActivity(streakAt(5, "2026-11-23T12:00:00-05:00"), t("2026-11-25T09:00:00-05:00"), nyNew).outcome).toBe("restarted");
  });

  it("signing in on a grace day counts; skipping one costs nothing", () => {
    let state = recordActivity(EMPTY_STREAK, t("2026-11-19T09:00:00-05:00"), nyNew).state; // Thu 1
    state = recordActivity(state, t("2026-11-20T09:00:00-05:00"), nyNew).state;
    expect(state.count).toBe(2); // Friday counts
    state = recordActivity(state, t("2026-11-22T09:00:00-05:00"), nyNew).state;
    expect(state.count).toBe(4); // Sunday, plus Shabbat passed over
    state = recordActivity(state, t("2026-11-23T09:00:00-05:00"), nyNew).state;
    expect(state.count).toBe(5); // and Monday carries on
  });

  it("days are the person's own: the same instants, two time zones", () => {
    const thuLA = "2026-11-19T21:00:00-08:00"; // Thursday night in Los Angeles (Friday 05:00 UTC)
    const monLA = t("2026-11-23T23:30:00-08:00"); // Monday 23:30 there, Tuesday 07:30 UTC
    const inLA = recordActivity(streakAt(5, thuLA, LA.timeZone), monLA, streakCalendar(LA));
    expect(inLA.outcome).toBe("continued");
    // In Jerusalem the sign-in was Friday morning and the second one is Tuesday.
    const inJerusalem = recordActivity(streakAt(5, thuLA, JERUSALEM.timeZone), monLA, streakCalendar(JERUSALEM));
    expect(inJerusalem.outcome).toBe("restarted");
  });

  it("a Thursday–Friday Yom Tov before the weekend waits for Monday (Shmini Atzeret 5789)", () => {
    const d = computeDeadline(t("2028-10-11T15:00:00-04:00"), nyNew);
    expect(d.dueDate).toBe("2028-10-16");
    expect(d.leeway.flatMap((p) => p.dates)).toEqual(["2028-10-12", "2028-10-13", "2028-10-14", "2028-10-15"]);
    expect(d.leeway.flatMap((p) => p.names)).toEqual(expect.arrayContaining(["Shmini Atzeret", "Simchat Torah", "Shabbat", "Sunday"]));
  });

  it("a weekend running into a Sunday–Monday Yom Tov waits for Tuesday (Shavuot 5789)", () => {
    const d = computeDeadline(t("2029-05-17T10:00:00-04:00"), nyNew);
    expect(d.dueDate).toBe("2029-05-22");
    expect(d.leeway.flatMap((p) => p.dates)).toEqual(["2029-05-18", "2029-05-19", "2029-05-20", "2029-05-21"]);
  });

  it("a mid-week two-day Yom Tov still needs the Thursday after it (Pesach 5788)", () => {
    expect(computeDeadline(t("2028-04-10T21:00:00-04:00"), nyNew).dueDate).toBe("2028-04-13");
  });

  it("across daylight saving changes the deadline is still 23:59:59.999 Monday", () => {
    const fall = computeDeadline(t("2026-10-29T12:00:00-04:00"), nyNew).deadline; // clocks fall back Sun 1 Nov
    expect([localDate(fall, NY.timeZone), localDate(fall + 1, NY.timeZone)]).toEqual(["2026-11-02", "2026-11-03"]);
    const spring = computeDeadline(t("2026-03-05T12:00:00-05:00"), nyNew).deadline; // spring forward Sun 8 Mar
    expect([localDate(spring, NY.timeZone), localDate(spring + 1, NY.timeZone)]).toEqual(["2026-03-09", "2026-03-10"]);
  });

  it("shows how long is left and which day it's due", () => {
    const s = getStreakStatus(streakAt(5, "2026-11-19T12:00:00-05:00"), t("2026-11-23T20:00:00-05:00"), nyNew);
    expect(s).toMatchObject({ alive: true, count: 5, atRisk: true, dueDate: "2026-11-23" });
    expect(s.remainingMs).toBe(4 * HOUR - 1);
  });
});

describe("the settings restore the old rule", () => {
  const thu = "2026-11-19T12:00:00-05:00";
  const mon = (hhmm: string) => t(`2026-11-23T${hhmm}:00-05:00`);

  it("both off: 30 hours moved past Shabbat, so Thursday → Monday breaks", () => {
    expect(recordActivity(streakAt(5, thu), mon("18:00"), ny).outcome).toBe("restarted");
    expect(computeDeadline(t(thu), ny).dueDate).toBeNull();
  });

  it("weekend grace alone: the hour window moves past the whole weekend, to Monday noon", () => {
    const cal = streakCalendar(NY, { weekendGrace: true, calendarDays: false });
    expect(computeDeadline(t(thu), cal).deadline).toBe(mon("12:00"));
    expect(recordActivity(streakAt(5, thu), mon("10:00"), cal).outcome).toBe("continued");
    expect(recordActivity(streakAt(5, thu), mon("18:00"), cal).outcome).toBe("restarted");
  });

  it("whole days alone: every day but Shabbat and Yom Tov is required", () => {
    const cal = streakCalendar(NY, { weekendGrace: false, calendarDays: true });
    expect(nextRequiredDate("2026-11-19", cal)).toBe("2026-11-20");
    expect(recordActivity(streakAt(5, "2026-11-23T00:05:00-05:00"), t("2026-11-24T23:50:00-05:00"), cal).outcome).toBe("continued");
    expect(recordActivity(streakAt(5, thu), mon("18:00"), cal).outcome).toBe("restarted");
  });
});

describe("whole days never shorten anything", () => {
  it.each(Object.entries(PLACES))("in %s, all year: never before the old deadline, always the end of a required day", (_name, place) => {
    const old = streakCalendar(place, OLD);
    const cal = streakCalendar(place, DEFAULT_STREAK_RULES);
    for (let last = t("2026-09-01T00:00:00Z"); last < t("2027-09-01T00:00:00Z"); last += 7 * HOUR) {
      const { deadline, dueDate } = computeDeadline(last, cal);
      expect(deadline).toBeGreaterThanOrEqual(computeDeadline(last, old).deadline);
      expect(deadline).toBeLessThan(last + 9 * 24 * HOUR); // STREAK_CERTAINLY_OVER_MS in server/admin.ts
      if (dueDate) {
        expect(cal.restricted(dueDate)).toEqual([]);
        expect(localDate(deadline, place.timeZone)).toBe(dueDate);
        expect(localDate(deadline + 1, place.timeZone)).toBe(addDays(dueDate, 1));
      }
    }
  });
});

describe("time zone helpers", () => {
  it("startOfDay is a local midnight, in a half-hour zone too", () => {
    expect(startOfDay("2026-11-23", "America/New_York")).toBe(t("2026-11-23T00:00:00-05:00"));
    expect(startOfDay("2026-11-23", "Asia/Kolkata")).toBe(t("2026-11-23T00:00:00+05:30"));
  });

  it("validTimeZone accepts a real zone and refuses junk", () => {
    expect(validTimeZone("America/Chicago")).toBe("America/Chicago");
    for (const bad of ["Mars/Base", "", null, "a".repeat(80), "<script>", 42]) expect(validTimeZone(bad)).toBeNull();
  });
});

describe("Yom Tov dates agree with ICU's Hebrew calendar", () => {
  // Two independent implementations (hebcal here, ICU in the runtime), so a
  // mistake in either can't pass by agreeing with itself.
  const hebrew = new Intl.DateTimeFormat("en-u-ca-hebrew", { month: "long", day: "numeric", timeZone: "UTC" });
  const DIASPORA_YOM_TOV = new Set([
    "Tishri 1", "Tishri 2", "Tishri 10", "Tishri 15", "Tishri 16", "Tishri 22", "Tishri 23",
    "Nisan 15", "Nisan 16", "Nisan 21", "Nisan 22", "Sivan 6", "Sivan 7",
  ]);
  it("for every day of 2026–2030, 13 a year", () => {
    let count = 0;
    for (let date = "2026-01-01"; date < "2031-01-01"; date = addDays(date, 1)) {
      const parts = hebrew.formatToParts(new Date(`${date}T12:00:00Z`));
      const key = `${parts.find((p) => p.type === "month")!.value} ${parts.find((p) => p.type === "day")!.value}`;
      const icu = DIASPORA_YOM_TOV.has(key);
      const site = holyDayNames(date, false).some((n) => n !== "Shabbat");
      expect([date, site]).toEqual([date, icu]);
      if (icu) count++;
    }
    expect(count).toBe(13 * 5);
  });
});
