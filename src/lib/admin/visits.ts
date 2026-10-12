/** Cleaning and classifying what the visitor log stores. Pure, so it's unit-tested. */

/**
 * The page's path only. Query strings and fragments are dropped, so a
 * password-reset link's token can never end up in the log.
 */
export function cleanPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  const path = value.split(/[?#]/)[0].slice(0, 300);
  return /^\/[\w\-./~%@:+!$&'()*,;=]*$/.test(path) ? path : null;
}

/**
 * Where the visitor came from: another site's address without its query
 * string, or null for links within this site and anything unusable.
 */
export function cleanReferrer(value: unknown, ownHost: string): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.host === ownHost) return null;
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 200);
  } catch {
    return null;
  }
}

const BOT_PATTERN =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python-requests|httpclient|go-http|okhttp|java\//i;

/** Search engines, link previews, monitors and scripts, by their user agent. */
export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_PATTERN.test(userAgent);
}

export function cleanText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export const VISIT_RANGES = { day: "Last 24 hours", week: "Last 7 days", month: "Last 30 days" } as const;
export type VisitRange = keyof typeof VISIT_RANGES;
export const VISIT_RANGE_MS: Record<VisitRange, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};
export const isVisitRange = (v: unknown): v is VisitRange => typeof v === "string" && Object.hasOwn(VISIT_RANGES, v);

export const VISIT_KINDS = { all: "Everyone", members: "Signed in", guests: "Guests", bots: "Bots" } as const;
export type VisitKind = keyof typeof VISIT_KINDS;
export const isVisitKind = (v: unknown): v is VisitKind => typeof v === "string" && Object.hasOwn(VISIT_KINDS, v);

/** The admin panel and API calls aren't page views worth logging. */
export function isTrackedPath(path: string): boolean {
  return !/^\/(admin|api)(\/|$)/.test(path);
}
