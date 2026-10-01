import { HDate, HebrewCalendar, flags } from "@hebcal/core";
import { addDays, weekday } from "./dates";

/** Returns the names of the Shabbat / Yom Tov observed on a date, or [] for a regular day. */
export type HolyDayLookup = (date: string) => string[];

const ISRAEL_TIME_ZONES = new Set(["Asia/Jerusalem", "Asia/Tel_Aviv"]);

/** Israel keeps one day of Yom Tov; everywhere else keeps two. */
export function observesIsraelSchedule(timeZone: string): boolean {
  return ISRAEL_TIME_ZONES.has(timeZone);
}

const cache = new Map<string, string[]>();

/**
 * Days when melacha is forbidden: every Shabbat, plus every Yom Tov
 * (Rosh Hashana, Yom Kippur, Sukkot, Shmini Atzeret / Simchat Torah, Pesach, Shavuot).
 * Chol HaMoed, fast days and Chanukah are regular days.
 */
export function holyDayNames(date: string, israel: boolean): string[] {
  const key = `${date}|${israel ? "il" : "dia"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const names: string[] = [];
  const [y, m, d] = date.split("-").map(Number);
  for (const event of HebrewCalendar.getHolidaysOnDate(new HDate(new Date(y, m - 1, d)), israel) ?? []) {
    if (event.getFlags() & flags.CHAG) names.push(event.render("en"));
  }
  if (weekday(date) === 6) names.push("Shabbat");

  if (cache.size > 5000) cache.clear();
  cache.set(key, names);
  return names;
}

export function holyDayLookup(israel: boolean): HolyDayLookup {
  return (date) => holyDayNames(date, israel);
}

export interface HolyBlock {
  dates: string[];
  names: string[];
}

/** The next run of two or more back-to-back Shabbat / Yom Tov days, starting from `from`. */
export function nextMultiDayYomTov(from: string, israel: boolean, horizonDays = 400): HolyBlock | null {
  for (let i = 0; i < horizonDays; i++) {
    const start = addDays(from, i);
    if (holyDayNames(start, israel).length === 0) continue;
    const dates = [start];
    while (holyDayNames(addDays(dates[dates.length - 1], 1), israel).length > 0) {
      dates.push(addDays(dates[dates.length - 1], 1));
    }
    if (dates.length >= 2) return { dates, names: [...new Set(dates.flatMap((d) => holyDayNames(d, israel)))] };
    i += dates.length - 1;
  }
  return null;
}
