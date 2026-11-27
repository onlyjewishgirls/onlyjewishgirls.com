/** Calendar-date helpers. Dates are plain "YYYY-MM-DD" strings in the user's time zone. */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The calendar date of an instant as seen in `timeZone`. */
export function localDate(instant: number, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

const wallClocks = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone` is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  let f = wallClocks.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallClocks.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant when the clock in `timeZone` reads `hour:minute` on `date`. */
export function zonedTime(date: string, hour: number, minute: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const guess = wall - offsetAt(wall, timeZone);
  // A second pass settles daylight-saving transitions.
  return wall - offsetAt(guess, timeZone);
}

/**
 * A usable IANA time zone name, canonicalised, or null. For a person's own zone
 * as reported by their browser: anything Intl can't load is refused, so a junk
 * value falls back to the portal's zone rather than being stored.
 */
export function validTimeZone(timeZone: unknown): string | null {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The first millisecond of a local date in `timeZone`. Where daylight saving
 * skips midnight, the day starts at the first moment that exists.
 */
export function startOfDay(date: string, timeZone: string): number {
  let at = zonedTime(date, 0, 0, timeZone);
  for (let i = 0; i < 16 && localDate(at, timeZone) < date; i++) at += 15 * 60_000;
  while (localDate(at - 60_000, timeZone) === date) at -= 60_000;
  return at;
}

/** "Monday, Nov 23" for a local date ("YYYY-MM-DD"). */
export function dueDayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
