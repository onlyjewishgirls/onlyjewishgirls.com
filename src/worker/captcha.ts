/**
 * The CAPTCHA wall (PORTAL-STANDARD §10) for this site: the shared Gate kit (gate-kit/, vendored
 * unchanged) with this site's hooks. worker.ts runs it in front of the OpenNext app, so nothing loads
 * (no page, `_next/static` file, image, API, console, sign-in, 404, robots.txt or favicon) until the
 * visitor has solved Cloudflare Turnstile.
 *
 * This runs in the Worker before Next.js does, so it must not import Next.js, OpenNext, "server-only"
 * or anything that does. It reaches D1 through env.DB and shares the app's migrations (schema.ts),
 * settings (settings-schema.ts) and alert path (alert-core.ts).
 */
import {
  createGate,
  isLoopbackHost,
  type Gate,
  type GateEventDetail,
  type GateEventType,
  type GateOptions,
  type GateStatsRow,
} from "../../gate-kit/gate.mjs";
import { settingsFromRows, type Settings } from "../lib/settings-schema";
import { recordAndSendWith, type AlertStore } from "../server/alert-core";
import { applyMigrations } from "../server/schema";

/** Shown on the challenge page ("Checking that you're human before loading OnlyJewishGirls."). Same as APP_NAME. */
export const SITE_NAME = "OnlyJewishGirls";

/** The OpenNext worker (`.open-next/worker.js`), or a stand-in in tests. */
export interface AppWorker {
  fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Response | Promise<Response>;
}

// ---- D1, outside the app ----

const migrated = new WeakSet<object>();

/** env.DB with the app's migrations applied (once per binding per isolate), so gate_stats always exists. */
async function database(env: CloudflareEnv): Promise<D1Database> {
  const d1 = env.DB;
  if (!migrated.has(d1)) {
    await applyMigrations(d1);
    migrated.add(d1);
  }
  return d1;
}

function store(d1: D1Database): AlertStore {
  return {
    all: async <T>(sql: string, ...params: (string | number | null)[]) => (await d1.prepare(sql).bind(...params).all<T>()).results,
    run: async (sql: string, ...params: (string | number | null)[]) => {
      const { meta } = await d1.prepare(sql).bind(...params).run();
      return { changes: meta.changes, lastRowId: meta.last_row_id };
    },
  };
}

async function loadSettings(d1: D1Database): Promise<Settings> {
  const { results } = await d1.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return settingsFromRows(results);
}

// ---- Hooks ----

/** `captcha_pass_hours` from the console's settings (asked once per solved CAPTCHA, never per request). */
export async function readGateSetting(key: string, env: CloudflareEnv): Promise<unknown> {
  const settings = (await loadSettings(await database(env))) as unknown as Record<string, unknown>;
  return key in settings ? settings[key] : null;
}

const STATS_RETENTION_HOURS = 400 * 24;
let lastPrunedAt = 0;

/** Batched hourly counts (at most one write per isolate per minute), shown on the console's overview. */
export async function writeGateStats(rows: GateStatsRow[], env: CloudflareEnv, now = Date.now()): Promise<void> {
  if (!rows.length) return;
  const d1 = await database(env);
  const statements = rows.map((r) =>
    d1
      .prepare(
        "INSERT INTO gate_stats (hour, event, count) VALUES (?, ?, ?) ON CONFLICT(hour, event) DO UPDATE SET count = count + excluded.count",
      )
      .bind(r.hour, r.event, r.count),
  );
  if (now - lastPrunedAt > 3_600_000) {
    // Keep about 13 months of counts (the console shows 30 days), checked at most once an hour per isolate.
    lastPrunedAt = now;
    statements.push(d1.prepare("DELETE FROM gate_stats WHERE hour < ?").bind(new Date(now - STATS_RETENTION_HOURS * 3_600_000).toISOString().slice(0, 13)));
  }
  await d1.batch(statements);
}

/** "2026-11-13" in the portal time zone. */
function dayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/**
 * The one email the wall itself may cause: GATE_MODE="off" (break-glass), at most once a day (portal
 * time zone), through the site's normal alert path (security_alerts + Plunk/Resend). Claiming the
 * day is a single conditional write, so isolates racing each other send it once.
 */
export async function gateOffAlert(detail: GateEventDetail, env: CloudflareEnv, now = Date.now()): Promise<number | null> {
  const d1 = await database(env);
  const settings = await loadSettings(d1);
  const day = dayIn(now, settings.time_zone);
  const claim = await d1
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('gate_off_alerted_on', ?1, ?2, 'captcha wall')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
       WHERE settings.value != excluded.value`,
    )
    .bind(JSON.stringify(day), now)
    .run();
  if (!claim.meta.changes) return null;
  return recordAndSendWith(
    { env, db: store(d1), site: SITE_NAME, timeZone: settings.time_zone, local: isLoopbackHost(detail.host) },
    {
      event: "captcha_off",
      title: "The CAPTCHA wall is OFF",
      key: day,
      what: `GATE_MODE is "off" on the Worker, so every visitor reaches ${detail.host} without solving a CAPTCHA. Delete the GATE_MODE variable to turn the wall back on. This email repeats once a day while it stays off.`,
      details: [
        ["Noticed on", `${detail.method} ${detail.host}${detail.path}`],
        ["Console", "Overview shows the CAPTCHA wall in red while it is off."],
      ],
      ip: detail.ip || null,
      country: detail.country,
      userAgent: detail.ua || null,
      now,
    },
    detail.host,
  );
}

/**
 * Counters only (§10: quiet by design). Every gate event is already counted by the kit and written by
 * onStats; nothing here alerts, audits or blacklists, except the daily GATE_MODE="off" alert.
 */
export function onGateEvent(type: GateEventType, detail: GateEventDetail, env: CloudflareEnv): Promise<unknown> | undefined {
  if (type === "gate_off") return gateOffAlert(detail, env);
  return undefined;
}

/**
 * The wall for this site. No `exempt` hook: this site has no machine clients, so nothing (no
 * webhook, monitor, crawler or allowlisted address) gets through without a pass.
 */
export function createCaptcha(overrides: Partial<GateOptions<CloudflareEnv>> = {}): Gate<CloudflareEnv> {
  return createGate<CloudflareEnv>({
    siteName: SITE_NAME,
    getSetting: readGateSetting,
    onStats: (rows, env) => writeGateStats(rows, env),
    onEvent: onGateEvent,
    ...overrides,
  });
}

/**
 * The order in every request (PORTAL-STANDARD §10):
 *   (1) deny list: this app keeps its deny list (ip_rules) in D1 and checks it itself, on sign-in,
 *       account, console and API routes; it runs after the wall, which is still in front of everything.
 *   (2) the CAPTCHA wall. Its own responses (challenge page, 403 JSON, 503, verify) go out untouched,
 *       never through a wrapper that sets CSP: the challenge page carries its own nonce CSP.
 *   (3) and (4) only with a pass (or GATE_MODE="off"): the OpenNext app, which holds the scanner/decoy
 *       rewrites, injection checks, auto-blacklist, alert emails, audit log and visitor log, then the
 *       pages, `_next/static`, public files and the 404. Its responses get Vary: Cookie and private caching.
 */
export async function handleRequest(
  captcha: Gate<CloudflareEnv>,
  app: AppWorker,
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const blocked = await captcha.handle(request, env, ctx);
  if (blocked) return blocked;
  return captcha.decorate(await app.fetch(request, env, ctx));
}
