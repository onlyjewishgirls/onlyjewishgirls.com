import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { bucketByDay, type DailyCount } from "@/lib/admin/days";
import { VISIT_RANGE_MS, isBot, type VisitKind, type VisitRange } from "@/lib/admin/visits";
import { all, first, run, type Param } from "./db";
import { requestInfo } from "./events";

const DAY = 86_400_000;
/** Kept 90 days, then deleted (checked at most once an hour per Worker instance). */
const RETENTION_MS = 90 * DAY;
/** The same browser opening the same page again within this long isn't a new visit. */
const REPEAT_MS = 30_000;
/** At most this many logged page views per IP address per minute, so one visitor can't flood the log. */
const PER_IP_PER_MINUTE = 30;
/**
 * At most this many logged page views in any 24 hours, so the log can never use up D1's free
 * daily write allowance (100,000 rows; each view is 2 with its index, and 2 more when pruned).
 */
const PER_DAY = 10_000;
let lastPrunedAt = 0;

export interface VisitInput {
  path: string;
  referrer: string | null;
  language: string | null;
  timeZone: string | null;
  screen: string | null;
}

/**
 * Logs one page view. A single statement that only writes when it isn't a
 * repeat, the IP address isn't flooding and the daily cap isn't reached, so
 * none of those cost a database write. The daily count reads two rows instead
 * of counting the day: ids only grow, so it's the newest id minus the first id
 * of the last 24 hours.
 */
export async function recordVisit(
  visit: VisitInput,
  visitorId: string,
  user: { id: number; username: string } | null,
  now = Date.now(),
) {
  const info = await requestInfo();
  let cf: { asn?: number; asOrganization?: string } | undefined;
  try {
    cf = getCloudflareContext().cf as typeof cf;
  } catch {
    cf = undefined;
  }
  await run(
    `INSERT INTO visits (at, visitor_id, user_id, username, path, referrer, ip, country, city, asn, network, user_agent,
                         language, time_zone, screen, bot)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
     WHERE NOT EXISTS (SELECT 1 FROM visits WHERE at > ?17 AND visitor_id = ?2 AND path = ?5)
       AND (SELECT COUNT(*) FROM visits WHERE at > ?18 AND ip IS ?7) < ?19
       AND COALESCE((SELECT MAX(id) FROM visits) - (SELECT id FROM visits WHERE at > ?20 ORDER BY at LIMIT 1) + 1, 0) < ?21`,
    now,
    visitorId,
    user?.id ?? null,
    user?.username ?? null,
    visit.path,
    visit.referrer,
    info.ip,
    info.country,
    info.city,
    typeof cf?.asn === "number" ? cf.asn : null,
    cf?.asOrganization?.slice(0, 100) ?? null,
    info.userAgent,
    visit.language,
    visit.timeZone,
    visit.screen,
    isBot(info.userAgent) ? 1 : 0,
    now - REPEAT_MS,
    now - 60_000,
    PER_IP_PER_MINUTE,
    now - DAY,
    PER_DAY,
  );
  if (now - lastPrunedAt > 60 * 60_000) {
    lastPrunedAt = now;
    await run("DELETE FROM visits WHERE at < ?", now - RETENTION_MS);
  }
}

// ---- Admin queries ----

export interface Visit {
  id: number;
  at: number;
  visitorId: string;
  userId: number | null;
  username: string | null;
  path: string;
  referrer: string | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  asn: number | null;
  network: string | null;
  userAgent: string | null;
  language: string | null;
  timeZone: string | null;
  screen: string | null;
  bot: boolean;
}

interface VisitRow {
  id: number;
  at: number;
  visitor_id: string;
  user_id: number | null;
  username: string | null;
  path: string;
  referrer: string | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  asn: number | null;
  network: string | null;
  user_agent: string | null;
  language: string | null;
  time_zone: string | null;
  screen: string | null;
  bot: number;
}

const toVisit = (r: VisitRow): Visit => ({
  id: r.id,
  at: r.at,
  visitorId: r.visitor_id,
  userId: r.user_id,
  username: r.username,
  path: r.path,
  referrer: r.referrer,
  ip: r.ip,
  country: r.country,
  city: r.city,
  asn: r.asn,
  network: r.network,
  userAgent: r.user_agent,
  language: r.language,
  timeZone: r.time_zone,
  screen: r.screen,
  bot: r.bot === 1,
});

export interface VisitFilter {
  range: VisitRange;
  kind: VisitKind;
  /** Matches path, IP, country code, city, network, username or referrer. */
  q?: string;
  visitorId?: string;
  userId?: number;
}

function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function whereFor(filter: VisitFilter, now: number): { sql: string; params: Param[] } {
  const where = ["at >= ?"];
  const params: Param[] = [now - VISIT_RANGE_MS[filter.range]];
  // username, not user_id: it stays set when the account is later deleted.
  if (filter.kind === "members") where.push("username IS NOT NULL");
  if (filter.kind === "guests") where.push("username IS NULL AND bot = 0");
  if (filter.kind === "bots") where.push("bot = 1");
  if (filter.visitorId) {
    where.push("visitor_id = ?");
    params.push(filter.visitorId);
  }
  if (filter.userId !== undefined) {
    where.push("user_id = ?");
    params.push(filter.userId);
  }
  const q = filter.q?.trim();
  if (q) {
    const p = contains(q.toLowerCase());
    where.push(
      `(LOWER(path) LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR LOWER(country) = ? OR LOWER(city) LIKE ? ESCAPE '\\'
        OR LOWER(network) LIKE ? ESCAPE '\\' OR LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(referrer) LIKE ? ESCAPE '\\')`,
    );
    params.push(p, p, q.toLowerCase(), p, p, p, p);
  }
  return { sql: `WHERE ${where.join(" AND ")}`, params };
}

export async function listVisits(
  filter: VisitFilter,
  options: { before?: number; limit?: number } = {},
  now = Date.now(),
): Promise<{ visits: Visit[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { sql, params } = whereFor(filter, now);
  const rows = await all<VisitRow>(
    `SELECT * FROM visits ${sql}${options.before !== undefined ? " AND id < ?" : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    ...(options.before !== undefined ? [options.before] : []),
    limit + 1,
  );
  const visits = rows.slice(0, limit).map(toVisit);
  return { visits, nextBefore: rows.length > limit ? visits[visits.length - 1].id : null };
}

export interface Ranked {
  label: string;
  count: number;
}

export interface VisitSummary {
  views: number;
  visitors: number;
  members: number;
  bots: number;
  topPages: Ranked[];
  topCountries: Ranked[];
  topReferrers: Ranked[];
  topNetworks: Ranked[];
  visitorsByDay: DailyCount[];
}

export async function visitSummary(filter: VisitFilter, timeZone: string, now = Date.now()): Promise<VisitSummary> {
  const { sql, params } = whereFor(filter, now);
  const top = (column: string) =>
    all<{ label: string; count: number }>(
      `SELECT ${column} AS label, COUNT(*) AS count FROM visits ${sql} AND ${column} IS NOT NULL
       GROUP BY ${column} ORDER BY count DESC LIMIT 8`,
      ...params,
    );
  const [totals, pages, countries, referrers, networks, daily] = await Promise.all([
    first<{ views: number; visitors: number; members: number; bots: number }>(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT user_id) AS members,
              COALESCE(SUM(bot), 0) AS bots
       FROM visits ${sql}`,
      ...params,
    ),
    top("path"),
    top("country"),
    top("referrer"),
    top("network"),
    // Last 30 days whatever the range, one row per browser per 15 minutes (see dashboardStats).
    all<{ at: number; visitor_id: string }>(
      `SELECT visitor_id, MIN(at) AS at FROM visits WHERE at >= ? AND bot = 0
       GROUP BY visitor_id, at / 900000 ORDER BY at DESC LIMIT 100000`,
      now - 31 * DAY,
    ),
  ]);
  return {
    views: totals?.views ?? 0,
    visitors: totals?.visitors ?? 0,
    members: totals?.members ?? 0,
    bots: totals?.bots ?? 0,
    topPages: pages,
    topCountries: countries,
    topReferrers: referrers,
    topNetworks: networks,
    visitorsByDay: bucketByDay(daily.map((r) => ({ at: r.at, key: r.visitor_id })), 30, now, timeZone),
  };
}

/** Page views and distinct visitors in the last 24 hours, for the overview. */
export async function visitsToday(now = Date.now()) {
  const row = await first<{ views: number; visitors: number }>(
    "SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM visits WHERE at >= ? AND bot = 0",
    now - DAY,
  );
  return { views: row?.views ?? 0, visitors: row?.visitors ?? 0 };
}
