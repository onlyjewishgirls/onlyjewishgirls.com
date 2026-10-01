import { describe, expect, it } from "vitest";
import { holyDayLookup, holyDayNames, observesIsraelSchedule } from "@/lib/streak/calendar";
import { addDays, daysBetween, localDate } from "@/lib/streak/dates";
import {
  EMPTY_STREAK,
  computeDeadline,
  getStreakStatus,
  recordActivity,
  type StreakState,
} from "@/lib/streak/engine";

const NY = "America/New_York";
const JLM = "Asia/Jerusalem";
const diaspora = holyDayLookup(false);
const israel = holyDayLookup(true);
const t = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

function streakAt(count: number, lastActivity: string, tz = NY): StreakState {
  const at = t(lastActivity);
  return { count, longest: count, lastActivityAt: at, lastCountedDate: localDate(at, tz), startedAt: at };
}

describe("date helpers", () => {
  it("reads calendar dates in the user's time zone", () => {
    expect(localDate(t("2026-10-02T03:30:00Z"), NY)).toBe("2026-10-01");
    expect(localDate(t("2026-10-02T03:30:00Z"), JLM)).toBe("2026-10-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2027-04-21", "2027-04-24")).toBe(3);
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

  it("uses the Israel schedule for Israeli time zones", () => {
    expect(observesIsraelSchedule("Asia/Jerusalem")).toBe(true);
    expect(observesIsraelSchedule("America/New_York")).toBe(false);
  });
});

describe("streak deadline", () => {
  it("is 30 hours after the last check-in on a regular weekday", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-19T10:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2026-10-20T16:00:00-04:00"));
    expect(leeway).toEqual([]);
  });

  it("covers a regular Shabbat with the plain 30 hours", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-23T16:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2026-10-24T22:00:00-04:00"));
    expect(leeway).toEqual([]);
  });

  it("adds 24 hours for a 2-day Yom Tov (Shmini Atzeret + Simchat Torah)", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-02T16:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2026-10-04T22:00:00-04:00"));
    expect(leeway).toHaveLength(1);
    expect(leeway[0].dates).toEqual(["2026-10-03", "2026-10-04"]);
    expect(leeway[0].extraHours).toBe(24);
    expect(leeway[0].names).toEqual(expect.arrayContaining(["Shmini Atzeret", "Shabbat", "Simchat Torah"]));
  });

  it("adds no leeway in Israel when that Yom Tov is only one day", () => {
    const { deadline, leeway } = computeDeadline(t("2026-10-02T16:00:00+03:00"), JLM, israel);
    expect(deadline).toBe(t("2026-10-03T22:00:00+03:00"));
    expect(leeway).toEqual([]);
  });

  it("adds 24 hours for 2-day Rosh Hashana, even in Israel", () => {
    const { deadline } = computeDeadline(t("2026-09-11T15:00:00+03:00"), JLM, israel);
    expect(deadline).toBe(t("2026-09-13T21:00:00+03:00"));
  });

  it("adds 48 hours for a 3-day Yom Tov (Pesach I, Pesach II, Shabbat)", () => {
    const { deadline, leeway } = computeDeadline(t("2027-04-21T16:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2027-04-24T22:00:00-04:00"));
    expect(leeway[0].dates).toEqual(["2027-04-22", "2027-04-23", "2027-04-24"]);
    expect(leeway[0].extraHours).toBe(48);
  });

  it("only counts the Yom Tov days still ahead when checking in mid-Yom Tov", () => {
    const { deadline } = computeDeadline(t("2027-04-22T10:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2027-04-22T10:00:00-04:00") + (30 + 24) * HOUR);
  });

  it("does not stretch for a Yom Tov that starts after the window ends", () => {
    // Monday morning: 30h ends Tuesday afternoon; Pesach starts Wednesday night.
    const { deadline, leeway } = computeDeadline(t("2027-04-19T09:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2027-04-20T15:00:00-04:00"));
    expect(leeway).toEqual([]);
  });

  it("treats a single midweek Yom Tov (Yom Kippur) like Shabbat", () => {
    const { deadline, leeway } = computeDeadline(t("2026-09-20T16:00:00-04:00"), NY, diaspora);
    expect(deadline).toBe(t("2026-09-21T22:00:00-04:00"));
    expect(leeway).toEqual([]);
  });
});

describe("recording check-ins", () => {
  it("starts a streak at 1", () => {
    const r = recordActivity(EMPTY_STREAK, t("2026-10-19T10:00:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("started");
    expect(r.state.count).toBe(1);
    expect(r.state.lastCountedDate).toBe("2026-10-19");
  });

  it("counts once per day but keeps pushing the deadline", () => {
    const first = recordActivity(EMPTY_STREAK, t("2026-10-19T08:00:00-04:00"), NY, diaspora);
    const second = recordActivity(first.state, t("2026-10-19T23:00:00-04:00"), NY, diaspora);
    expect(second.outcome).toBe("same-day");
    expect(second.state.count).toBe(1);
    expect(computeDeadline(second.state.lastActivityAt!, NY, diaspora).deadline).toBe(
      t("2026-10-21T05:00:00-04:00"),
    );
  });

  it("adds a day for each new day within 30 hours", () => {
    const r = recordActivity(streakAt(5, "2026-10-19T23:00:00-04:00"), t("2026-10-21T01:00:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(6);
  });

  it("keeps the streak over Shabbat and counts Shabbat", () => {
    const r = recordActivity(streakAt(10, "2026-10-23T16:00:00-04:00"), t("2026-10-24T20:30:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(11);
  });

  it("credits Shabbat even when it was skipped over", () => {
    const r = recordActivity(streakAt(10, "2026-10-23T21:00:00-04:00"), t("2026-10-25T02:00:00-04:00"), NY, diaspora);
    expect(r.state.count).toBe(12); // Shabbat + Sunday
  });

  it("breaks the streak after 30 hours on a regular week", () => {
    const r = recordActivity(streakAt(10, "2026-10-23T16:00:00-04:00"), t("2026-10-25T10:00:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("restarted");
    expect(r.previousCount).toBe(10);
    expect(r.state.count).toBe(1);
    expect(r.state.longest).toBe(10);
  });

  it("survives a 2-day Yom Tov and counts both days", () => {
    const r = recordActivity(streakAt(30, "2026-10-02T16:00:00-04:00"), t("2026-10-04T20:30:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(32);
  });

  it("survives a 3-day Yom Tov and counts all three days", () => {
    const r = recordActivity(streakAt(30, "2027-04-21T16:00:00-04:00"), t("2027-04-24T21:15:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("continued");
    expect(r.state.count).toBe(33);
  });

  it("still requires checking in on Erev Yom Tov", () => {
    // Last check-in Tuesday; nothing Wednesday (Erev Pesach) -> lost by Motzei Shabbat.
    const r = recordActivity(streakAt(30, "2027-04-20T20:00:00-04:00"), t("2027-04-24T21:15:00-04:00"), NY, diaspora);
    expect(r.outcome).toBe("restarted");
  });
});

describe("streak status", () => {
  it("shows the hourglass in the last 4 hours", () => {
    const state = streakAt(7, "2026-10-19T10:00:00-04:00");
    expect(getStreakStatus(state, t("2026-10-20T11:00:00-04:00"), NY, diaspora).atRisk).toBe(false);
    const late = getStreakStatus(state, t("2026-10-20T13:00:00-04:00"), NY, diaspora);
    expect(late.atRisk).toBe(true);
    expect(late.remainingMs).toBe(3 * HOUR);
    expect(late.count).toBe(7);
  });

  it("reports 0 once the deadline has passed", () => {
    const status = getStreakStatus(streakAt(7, "2026-10-19T10:00:00-04:00"), t("2026-10-20T16:00:01-04:00"), NY, diaspora);
    expect(status.alive).toBe(false);
    expect(status.count).toBe(0);
    expect(status.longest).toBe(7);
  });
});
