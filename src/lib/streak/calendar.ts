import { GeoLocation, HDate, HebrewCalendar, Zmanim, flags } from "@hebcal/core";
import { addDays, localDate, startOfDay, weekday, zonedTime } from "./dates";

/** Returns the names of the Shabbat / Yom Tov observed on a date, or [] for a regular day. */
export type HolyDayLookup = (date: string) => string[];

const ISRAEL_TIME_ZONES = new Set(["Asia/Jerusalem", "Asia/Tel_Aviv"]);

/** Israel keeps one day of Yom Tov; everywhere else keeps two. */
export function observesIsraelSchedule(timeZone: string, country?: string | null): boolean {
  return country === "IL" || ISRAEL_TIME_ZONES.has(timeZone);
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

/**
 * How the streak is judged (PORTAL-STANDARD §4, "Weekend grace and whole days").
 *  - weekendGrace: Friday and Sunday are grace days, like Shabbat and Yom Tov, so
 *    the only days anyone has to check in on are Monday to Thursday (minus Yom Tov).
 *  - calendarDays: the streak lasts until the end of the next required day in the
 *    person's own time zone, never less than the old window. Any time Thursday,
 *    then any time Monday, keeps it.
 * Both off gives exactly the rule this site had before (30 hours, moved past
 * Shabbat / Yom Tov).
 */
export interface StreakRules {
  weekendGrace: boolean;
  calendarDays: boolean;
}

export const DEFAULT_STREAK_RULES: StreakRules = { weekendGrace: true, calendarDays: true };
/** The rule before weekend grace: a 30-hour window, moved past Shabbat and Yom Tov only. */
export const HOUR_WINDOW_RULES: StreakRules = { weekendGrace: false, calendarDays: false };

/** "Friday" / "Sunday" for a weekend grace day that isn't Yom Tov, else null. */
export function graceDayName(date: string): string | null {
  const day = weekday(date);
  return day === 5 ? "Friday" : day === 0 ? "Sunday" : null;
}

/**
 * Why nobody has to check in on this date: the Shabbat / Yom Tov names, or the
 * grace weekday when weekend grace is on. [] for a required day. A Yom Tov that
 * falls on a Friday or Sunday is named as the Yom Tov.
 */
export function restrictedNames(date: string, israel: boolean, weekendGrace: boolean): string[] {
  const holy = holyDayNames(date, israel);
  if (holy.length || !weekendGrace) return holy;
  const grace = graceDayName(date);
  return grace ? [grace] : [];
}

/** Where a user is, for working out when Shabbat and Yom Tov start and end for them. */
export interface Place {
  timeZone: string;
  israel: boolean;
  /** Approximate coordinates (city level). null when unknown. */
  latitude: number | null;
  longitude: number | null;
}

/** A run of back-to-back Shabbat / Yom Tov days, with when it starts and ends for this place. */
export interface HolyPeriod {
  dates: string[];
  names: string[];
  start: number;
  end: number;
}

/**
 * Generous bounds that cover every common custom: candle lighting as early as
 * 40 minutes before sunset (Jerusalem), and havdalah as late as 72 minutes
 * after sunset (Rabbeinu Tam).
 */
export const STARTS_BEFORE_SUNSET_MINUTES = 40;
export const ENDS_AFTER_SUNSET_MINUTES = 72;

const MINUTE = 60_000;

function sunset(place: Place, date: string): number | null {
  if (place.latitude === null || place.longitude === null) return null;
  const [y, m, d] = date.split("-").map(Number);
  const location = new GeoLocation(null, place.latitude, place.longitude, 0, place.timeZone);
  const time = new Zmanim(location, new Date(y, m - 1, d), false).sunset().getTime();
  return Number.isNaN(time) ? null : time; // no sunset that day (polar regions)
}

/**
 * When the coordinates are unknown, or the sun doesn't set (polar day or night),
 * assume Shabbat or Yom Tov runs from noon on Erev until 3 AM after the last day.
 */
function periodStart(place: Place, erev: string): number {
  const s = sunset(place, erev);
  return s === null ? zonedTime(erev, 12, 0, place.timeZone) : s - STARTS_BEFORE_SUNSET_MINUTES * MINUTE;
}

function periodEnd(place: Place, lastDay: string): number {
  const s = sunset(place, lastDay);
  return s === null ? zonedTime(addDays(lastDay, 1), 3, 0, place.timeZone) : s + ENDS_AFTER_SUNSET_MINUTES * MINUTE;
}

/**
 * Shabbat / Yom Tov periods for this place that overlap the time span [from, to]
 * (inclusive). With `weekendGrace`, Friday and Sunday join them as whole local
 * days, so a weekend reads as one block: from midnight on Friday until midnight
 * after Sunday (or the end of an adjoining Yom Tov, whichever is later).
 */
export function holyPeriods(place: Place, from: number, to: number, weekendGrace = false): HolyPeriod[] {
  const isHoly = (date: string) => holyDayNames(date, place.israel).length > 0;
  const isRestricted = (date: string) => restrictedNames(date, place.israel, weekendGrace).length > 0;
  let date = addDays(localDate(from, place.timeZone), -1);
  while (isRestricted(addDays(date, -1))) date = addDays(date, -1); // start of a period already under way
  const lastDate = addDays(localDate(to, place.timeZone), 1);

  const periods: HolyPeriod[] = [];
  for (; date <= lastDate; date = addDays(date, 1)) {
    if (!isRestricted(date)) continue;
    const dates = [date];
    while (isRestricted(addDays(dates[dates.length - 1], 1))) dates.push(addDays(dates[dates.length - 1], 1));
    date = dates[dates.length - 1];
    const holy = dates.filter(isHoly);
    const starts: number[] = [];
    const ends: number[] = [];
    if (holy.length) {
      starts.push(periodStart(place, addDays(holy[0], -1)));
      ends.push(periodEnd(place, holy[holy.length - 1]));
    }
    if (!isHoly(dates[0])) starts.push(startOfDay(dates[0], place.timeZone));
    if (!isHoly(date)) ends.push(startOfDay(addDays(date, 1), place.timeZone));
    const start = Math.min(...starts);
    const end = Math.max(...ends);
    if (start <= to && end > from) {
      periods.push({
        dates,
        names: [...new Set(dates.flatMap((d) => restrictedNames(d, place.israel, weekendGrace)))],
        start,
        end,
      });
    }
  }
  return periods;
}

/** Everything the streak rules need to know about a user's calendar. */
export interface StreakCalendar {
  timeZone: string;
  rules: StreakRules;
  /** Names of the Shabbat / Yom Tov on a local date, or [] for a regular day. */
  holyDays: HolyDayLookup;
  /** Why no check-in is needed on a local date (Shabbat, Yom Tov, and grace days), or [] for a required day. */
  restricted: HolyDayLookup;
  /** Shabbat / Yom Tov periods (and grace days, with weekend grace) overlapping [from, to]. */
  periods: (from: number, to: number) => HolyPeriod[];
}

export function streakCalendar(place: Place, rules: StreakRules = DEFAULT_STREAK_RULES): StreakCalendar {
  return {
    timeZone: place.timeZone,
    rules,
    holyDays: holyDayLookup(place.israel),
    restricted: (date) => restrictedNames(date, place.israel, rules.weekendGrace),
    periods: (from, to) => holyPeriods(place, from, to, rules.weekendGrace),
  };
}
