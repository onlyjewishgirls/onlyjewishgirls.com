import { GeoLocation, HDate, HebrewCalendar, Zmanim, flags } from "@hebcal/core";
import { addDays, localDate, weekday, zonedTime } from "./dates";

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

/** Shabbat / Yom Tov periods for this place that overlap the time span [from, to] (inclusive). */
export function holyPeriods(place: Place, from: number, to: number): HolyPeriod[] {
  const isHoly = (date: string) => holyDayNames(date, place.israel).length > 0;
  let date = addDays(localDate(from, place.timeZone), -1);
  while (isHoly(addDays(date, -1))) date = addDays(date, -1); // start of a period already under way
  const lastDate = addDays(localDate(to, place.timeZone), 1);

  const periods: HolyPeriod[] = [];
  for (; date <= lastDate; date = addDays(date, 1)) {
    if (!isHoly(date)) continue;
    const dates = [date];
    while (isHoly(addDays(dates[dates.length - 1], 1))) dates.push(addDays(dates[dates.length - 1], 1));
    date = dates[dates.length - 1];
    const start = periodStart(place, addDays(dates[0], -1));
    const end = periodEnd(place, date);
    if (start <= to && end > from) {
      periods.push({ dates, names: [...new Set(dates.flatMap((d) => holyDayNames(d, place.israel)))], start, end });
    }
  }
  return periods;
}

/** Everything the streak rules need to know about a user's calendar. */
export interface StreakCalendar {
  timeZone: string;
  /** Names of the Shabbat / Yom Tov on a local date, or [] for a regular day. */
  holyDays: HolyDayLookup;
  /** Shabbat / Yom Tov periods overlapping [from, to]. */
  periods: (from: number, to: number) => HolyPeriod[];
}

export function streakCalendar(place: Place): StreakCalendar {
  return {
    timeZone: place.timeZone,
    holyDays: holyDayLookup(place.israel),
    periods: (from, to) => holyPeriods(place, from, to),
  };
}
