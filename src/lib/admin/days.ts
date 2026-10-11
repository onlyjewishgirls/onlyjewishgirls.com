import { addDays, localDate } from "@/lib/streak/dates";

export interface DailyCount {
  date: string;
  count: number;
}

/**
 * One entry per day for the last `days` days in `timeZone`, oldest first.
 * Steps whole calendar days, so a daylight-saving change can't skip or repeat a date.
 */
export function bucketByDay(
  instants: { at: number; key: number | string | null }[],
  days: number,
  now: number,
  timeZone: string,
): DailyCount[] {
  const today = localDate(now, timeZone);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(addDays(today, -i));
  const sets = new Map(dates.map((d) => [d, new Set<number | string>()]));
  for (const { at, key } of instants) {
    const set = sets.get(localDate(at, timeZone));
    if (set) set.add(key ?? `${at}`);
  }
  return dates.map((date) => ({ date, count: sets.get(date)!.size }));
}
