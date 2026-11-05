/** Shared by the sign-in route and the admin console (lock state). No server-only imports: unit-tested. */

/** 10 wrong passwords in 15 minutes locks the account until the window ends. */
export const LOGIN_ATTEMPTS_PER_WINDOW = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const loginAccountKey = (userId: number) => `login:account:${userId}`;

/** "3:42 PM EST" today, or "Thu, Nov 5, 3:42 PM EST" on another day, in the reader's time zone. */
export function untilText(ms: number, timeZone: string, now = Date.now()): string {
  const day = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone });
  const sameDay = day(ms) === day(now);
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
