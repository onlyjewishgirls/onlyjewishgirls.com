import "server-only";
import { describeDevice } from "@/lib/admin/format";
import { ROLE_LABELS } from "@/lib/admin/permissions";
import { rangeProblem, ipInRange, isUnblockableIp, threatBand, threatScore, type StrikeCounts } from "@/lib/security";
import { coerceSetting, SETTING_GROUPS, SETTINGS, settingDef, type SettingValue } from "@/lib/settings-schema";
import { monthKey } from "@/lib/streak/restore";
import { currentRouting } from "../alerts";
import { all, first, run, type Param } from "../db";
import { APP_NAME } from "../env";
import { logEvent } from "../events";
import { COUNTRY_PRESETS, countryName, countryRefused, parseCountryRule, type CountryRule } from "@/lib/country-rule";
import { getCountryRule, requestCountry, saveCountryRule } from "../country-rule";
import { addRule, findRule, isAllowlisted, isLive, listRules, matchingRules, revokeRule, updateRule, type IpRule } from "../ip-rules";
import { emailConfigured } from "../mailer";
import { listSessions } from "../session";
import { getSettings, saveSettings } from "../settings";
import { currentRestorePlan, streakStatusOf } from "../streak";
import { toUser, type UserRow } from "../users";
import { capabilitiesFor, err, idParam, iso, json, need, pageParams, personRef, type ConsoleCtx } from "./core";
import { revokeOneSession, sessionEntry } from "./people";
import { recentSecurityEvents } from "./records";

const DAY = 86_400_000;
const IDLE_MS = 3 * DAY;

// ---- Bootstrap ----

export const FEATURES = {
  overview: true,
  people: true,
  roles: true,
  invitations: false, // no invitation flow: admins create accounts with a temporary password
  streaks: true,
  settings: true,
  security: true,
  ip_allowlist: true,
  deny_list: true,
  country_rule: true, // PORTAL-STANDARD §9: "Countries" on the IP allowlist page
  devices: false, // no trusted-device model; sessions carry the device
  sessions: true,
  audit: true,
  alerts: true,
  people_create: true,
  people_delete: true,
  people_email: true,
  people_phones: false, // one mobile number, edited in the profile
  people_permissions: true,
  people_account_type: false,
  people_multi_role: false,
  people_lock: true,
  people_disable: false,
  mfa_email_toggle: false, // set per request in bootstrap: on when email is configured
  mfa_require: false, // two-step is mandatory for everyone
  access_requests: false,
  roles_rank: false,
  streak_restores: true,
  ip_tiers: false,
  ip_link_person: false,
  deny_auto: true,
  deny_expiry: true,
  country_deny_mode: true,
  device_approval: false,
  device_block: false,
  visitors_detail: true,
  visitors_export: false,
  audit_revert: true,
  audit_verify: false,
  audit_export: false,
  alerts_test: true,
} as const;

export async function bootstrap(ctx: ConsoleCtx) {
  const settings = await getSettings();
  const me = ctx.me;
  const banners: string[] = [];
  if (!settings.auto_block_enabled) banners.push("Auto-blacklisting is OFF: suspicious IPs are reported but not blocked.");
  if (!emailConfigured()) banners.push("Email isn't configured (PLUNK_API_KEY isn't set), so security alerts are recorded but not delivered.");
  const pending = await first<{ deny: number }>(
    "SELECT COUNT(*) AS deny FROM ip_rules WHERE kind = 'deny' AND source = 'auto' AND revoked_at IS NULL AND created_at >= ?",
    ctx.now - DAY,
  );
  return json({
    api: 1,
    // Sidebar badge: automatic blocks in the last 24 hours, for someone to look over.
    counts: { deny: pending?.deny ?? 0 },
    me: {
      id: String(me.id),
      name: `${me.firstName} ${me.lastName}`,
      username: me.username,
      email: me.email,
      role: me.role === "owner" ? "superadmin" : me.role,
      role_label: ROLE_LABELS[me.role],
    },
    is_owner: ctx.isOwner,
    perms: capabilitiesFor(me),
    site: {
      name: APP_NAME,
      domain: ctx.req.nextUrl.hostname,
      timezone: settings.time_zone,
      login_url: "/login",
      home_url: "/home",
      sign_out_url: "/api/auth/logout",
      person_noun: "person",
      people_noun: "people",
      staff_id_label: "Account ID",
    },
    features: { ...FEATURES, mfa_email_toggle: emailConfigured() },
    your_ip: ctx.ip,
    banner: banners.length ? { tone: "warn", text: banners.join(" ") } : null,
    links: [
      { label: "Visitor log (pages, referrers)", href: "/admin/visitors" },
      { label: "Classic admin panel", href: "/admin/overview" },
      { label: "Back to the site", href: "/home" },
    ],
    enums: {
      statuses: [
        { value: "active", label: "Active", tone: "ok" },
        { value: "locked", label: "Locked", tone: "warn" },
        { value: "suspended", label: "Suspended", tone: "danger" },
      ],
    },
  });
}

// ---- Overview ----

export async function overview(ctx: ConsoleCtx) {
  need(ctx, "overview.view");
  const now = ctx.now;
  const settings = await getSettings();
  const c = await first<{
    total: number;
    active_day: number;
    complete: number;
    suspended: number;
    online: number;
    locked: number;
    failed: number;
    auto7: number;
    auto24: number;
    alerts24: number;
    failed_alerts: number;
    owner_pk: number;
    admins_no_pk: number;
    owner_lockouts: number;
    incomplete: number;
  }>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(MAX(COALESCE(streak_last_activity_at, 0), COALESCE(last_login_at, 0)) >= ?1), 0) AS active_day,
       COALESCE(SUM(totp_enabled_at IS NOT NULL AND recovery_codes_created_at IS NOT NULL AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = users.id)), 0) AS complete,
       COALESCE(SUM(suspended_at IS NOT NULL), 0) AS suspended,
       (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE stage = 'full' AND expires_at > ?2 AND last_seen_at > ?3) AS online,
       COALESCE(SUM((locked_until IS NOT NULL AND locked_until > ?2) OR EXISTS (SELECT 1 FROM rate_limits r WHERE r.reset_at > ?2
          AND ((r.key = 'login:account:' || users.id AND r.count >= 10) OR (r.key = 'mfa-failures:' || users.id AND r.count >= 10)))), 0) AS locked,
       (SELECT COUNT(*) FROM events WHERE at >= ?1 AND type IN ('signin.failed', 'signin.unknown', 'signin.mfa_failed')) AS failed,
       (SELECT COUNT(*) FROM ip_rules WHERE kind = 'deny' AND source = 'auto' AND created_at >= ?4) AS auto7,
       (SELECT COUNT(*) FROM ip_rules WHERE kind = 'deny' AND source = 'auto' AND created_at >= ?1) AS auto24,
       (SELECT COUNT(*) FROM security_alerts WHERE at >= ?1) AS alerts24,
       (SELECT COUNT(*) FROM security_alerts WHERE at >= ?4 AND status = 'failed') AS failed_alerts,
       (SELECT COUNT(*) FROM users o WHERE o.role = 'owner' AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = o.id)) AS owner_pk,
       (SELECT COUNT(*) FROM users a WHERE a.role IN ('admin', 'owner') AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = a.id)) AS admins_no_pk,
       (SELECT COUNT(*) FROM ip_rules WHERE kind = 'deny' AND owner_session = 1 AND revoked_at IS NULL) AS owner_lockouts,
       COALESCE(SUM(NOT (totp_enabled_at IS NOT NULL AND recovery_codes_created_at IS NOT NULL AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = users.id))), 0) AS incomplete
     FROM users`,
    now - DAY,
    now,
    now - IDLE_MS,
    now - 7 * DAY,
  );
  const v = c!;
  const posture: { severity: "ok" | "warn" | "danger"; title: string; detail?: string; href?: string }[] = [];
  posture.push(
    emailConfigured()
      ? { severity: "ok", title: "Email is configured; security alerts are delivered." }
      : { severity: "danger", title: "Email isn't configured.", detail: "Alerts are recorded but not sent. Set the PLUNK_API_KEY secret on the Worker." },
  );
  posture.push(
    settings.auto_block_enabled
      ? { severity: "ok", title: "Auto-blacklisting is on." }
      : { severity: "danger", title: "Auto-blacklisting is off.", href: "#settings" },
  );
  posture.push(
    v.admins_no_pk === 0
      ? { severity: "ok", title: "Every admin has a passkey." }
      : { severity: "warn", title: `${v.admins_no_pk} admin account${v.admins_no_pk === 1 ? " has" : "s have"} no passkey.`, href: "#people?role=admin" },
  );
  if (v.owner_lockouts > 0) {
    posture.push({ severity: "danger", title: "An auto-block covers an IP the owner was signed in from.", href: "#deny" });
  }
  if (v.failed_alerts > 0) posture.push({ severity: "warn", title: `${v.failed_alerts} alert email${v.failed_alerts === 1 ? "" : "s"} failed to send this week.`, href: "#alerts?status=failed" });
  posture.push({ severity: "ok", title: "Two-step sign-in (passkey + authenticator app) is mandatory for everyone." });
  posture.push(
    settings.allowlist_mode === "off"
      ? { severity: "ok", title: "The IP allowlist marks trusted addresses; it isn't enforced.", href: "#settings" }
      : { severity: "ok", title: `The IP allowlist is enforced for ${settings.allowlist_mode === "admins" ? "admins" : "everyone"}.` },
  );
  const countries = await getCountryRule();
  posture.push(
    countries.mode === "off" || countries.countries.length === 0
      ? { severity: "ok", title: "No country rule: sign-in is open from every country.", href: "#ips" }
      : {
          severity: "ok",
          title: `Country rule: sign-in ${countries.mode === "allow" ? "only from" : "refused from"} ${countries.countries.join(", ")}.`,
          href: "#ips",
        },
  );
  const routing = currentRouting(ctx.req.nextUrl.host);
  posture.push({ severity: "ok", title: `Alerts go from ${routing.from} to ${routing.to}.` });
  return json({
    stats: [
      { key: "people", label: "People", value: v.total, sub: `${v.active_day} active in 24 h`, href: "#people" },
      { key: "online", label: "Signed in now", value: v.online, href: "#sessions" },
      { key: "mfa_coverage", label: "Two-step complete", value: v.total ? v.complete / v.total : 1, format: "percent", tone: v.complete === v.total ? "ok" : "warn" },
      { key: "suspended", label: "Suspended", value: v.suspended, tone: v.suspended ? "warn" : null, href: "#people?status=suspended" },
      { key: "locked", label: "Locked now", value: v.locked, tone: v.locked ? "warn" : null, href: "#people?status=locked" },
      { key: "failed", label: "Failed sign-ins (24 h)", value: v.failed, tone: v.failed ? "warn" : null, href: "#audit?category=auth" },
      { key: "auto_blocks", label: "Auto-blocks (7 days)", value: v.auto7, tone: v.auto7 ? "danger" : null, href: "#deny" },
      { key: "alerts", label: "Alerts (24 h)", value: v.alerts24, href: "#alerts" },
    ],
    posture,
    queue: [
      { label: "People with two-step not finished", count: v.incomplete, href: "#people?flag=mfa_missing", tone: "warn" },
      { label: "Locked accounts", count: v.locked, href: "#people?status=locked", tone: "warn" },
      { label: "IPs auto-blocked in the last 24 h", count: v.auto24, href: "#deny", tone: "danger" },
    ].filter((q) => q.count > 0),
    events: await recentSecurityEvents(15),
  });
}

// ---- Roles ----

const CATALOG = [
  { key: "people.manage", label: "View everyone; manage member accounts", group: "People" },
  { key: "admins.manage", label: "Manage admin accounts and roles", group: "People", danger: true },
  { key: "streaks.manage", label: "Set other people's streaks and grant restores", group: "Streaks" },
  { key: "settings.manage", label: "Change settings", group: "Settings", danger: true },
  { key: "ips.manage", label: "Change the IP allowlist and deny list", group: "Access control", danger: true },
  { key: "audit.revert", label: "Revert changes from the audit log", group: "Records" },
];

export async function roles(ctx: ConsoleCtx) {
  need(ctx, "roles.view");
  const counts = await all<{ role: string; n: number }>("SELECT role, COUNT(*) AS n FROM users GROUP BY role");
  const n = (r: string) => counts.find((c) => c.role === r)?.n ?? 0;
  return json({
    items: [
      { id: "owner", key: "owner", name: "Owner", description: "The site owner. Everything, including admins, settings and the IP lists.", permissions: CATALOG.map((c) => c.key), members: n("owner"), system: true, all: true, editable: false, deletable: false },
      { id: "admin", key: "admin", name: "Admin", description: "Sees everything and manages member accounts. Not other admins or the owner. Streaks need the streaks.manage permission.", permissions: ["people.manage"], members: n("admin"), system: true, all: false, editable: false, deletable: false },
      { id: "member", key: "member", name: "Member", description: "A normal account. No admin access.", permissions: [], members: n("member"), system: true, all: false, editable: false, deletable: false },
    ],
    catalog: CATALOG.map((c) => ({ danger: false, ...c })),
    can_manage: false,
    note: "This site has three fixed roles. The owner changes someone's role and extra permissions (streaks.manage) from their record under People.",
  });
}

// ---- Streaks ----

export async function streaks(ctx: ConsoleCtx) {
  need(ctx, "streaks.view");
  const settings = await getSettings();
  const month = monthKey(ctx.now, settings.time_zone);
  const rows = await all<UserRow & { used: number; extra: number }>(
    `SELECT u.*,
       (SELECT COUNT(*) FROM streak_restores r WHERE r.user_id = u.id AND r.month = ?1 AND r.kind = 'self') AS used,
       COALESCE((SELECT extra FROM streak_restore_grants g WHERE g.user_id = u.id AND g.month = ?1), 0) AS extra
     FROM users u WHERE u.streak_count > 0 OR u.streak_longest > 0 ORDER BY u.streak_count DESC, u.streak_longest DESC LIMIT 200`,
    month,
  );
  const items = rows
    .map((row) => {
      const u = toUser(row)!;
      const s = streakStatusOf(u, ctx.now);
      const allowance = settings.streak_restores === 0 ? row.extra : settings.streak_restores + row.extra;
      return {
        person: personRef(u),
        current: s.count,
        longest: s.longest,
        alive: s.alive,
        hours_left: s.remainingMs === null ? null : Math.round((s.remainingMs / 3_600_000) * 10) / 10,
        restores_used: row.used,
        restores_left: Math.max(0, allowance - row.used),
        restore_to: currentRestorePlan(u, ctx.now)?.to ?? null,
      };
    })
    .sort((a, b) => b.current - a.current || b.longest - a.longest)
    .map((item, i) => ({ ...item, rank: i + 1 }));
  return json({
    month,
    timezone: settings.time_zone,
    items,
    restores_per_month: settings.streak_restores,
    can_set_self: ctx.isOwner,
    settings_group: "streaks",
  });
}

export async function streakRestores(ctx: ConsoleCtx) {
  need(ctx, "streaks.view");
  const { limit } = pageParams(ctx);
  const where: string[] = [];
  const params: Param[] = [];
  const person = Number(ctx.query.get("person"));
  if (person) {
    where.push("r.user_id = ?");
    params.push(person);
  }
  const cursor = Number(ctx.query.get("cursor"));
  if (cursor) {
    where.push("r.id < ?");
    params.push(cursor);
  }
  const rows = await all<{ id: number; user_id: number; username: string | null; by_user_id: number | null; by_username: string | null; kind: string; from_count: number; to_count: number; month: string; created_at: number }>(
    `SELECT r.*, u.username, b.username AS by_username FROM streak_restores r
     LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users b ON b.id = r.by_user_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  return json({
    items: rows.slice(0, limit).map((r) => ({
      id: String(r.id),
      person: { id: String(r.user_id), name: r.username ?? String(r.user_id), username: r.username },
      by: r.by_user_id ? { id: String(r.by_user_id), name: r.by_username ?? String(r.by_user_id), username: r.by_username } : null,
      kind: r.kind,
      from_count: r.from_count,
      to_count: r.to_count,
      month: r.month,
      created_at: iso(r.created_at),
    })),
    next_cursor: rows.length > limit ? String(rows[limit - 1].id) : null,
  });
}

// ---- Settings ----

async function settingItems(ctx: ConsoleCtx) {
  const values = (await getSettings()) as unknown as Record<string, SettingValue>;
  const editable = ctx.caps.has("settings.manage");
  const routing = currentRouting(ctx.req.nextUrl.host);
  const items: Record<string, unknown>[] = SETTINGS.map((d) => ({
    key: d.key,
    group: d.group,
    label: d.label,
    description: d.description,
    type: d.type,
    value: values[d.key],
    default: d.default,
    min: d.min,
    max: d.max,
    unit: d.unit,
    options: d.options,
    editable,
    danger: d.danger,
    confirm: d.confirm,
  }));
  items.push(
    { key: "alerts_from", group: "general", label: "Alerts are sent from", type: "readonly", value: `${routing.from} (${routing.from_source === "default" ? "default" : "ALERTS_EMAIL_FROM"})`, description: "Set ALERTS_EMAIL_FROM on the Worker to change it.", editable: false },
    { key: "alerts_to", group: "general", label: "Alerts are sent to", type: "readonly", value: `${routing.to} (${routing.to_source === "default" ? "default" : "ALERTS_EMAIL_TO"})`, description: "Set ALERTS_EMAIL_TO on the Worker to change it.", editable: false },
  );
  return items;
}

export async function getSettingsRoute(ctx: ConsoleCtx) {
  need(ctx, "settings.view");
  return json({ groups: SETTING_GROUPS, items: await settingItems(ctx), save: "group" });
}

export async function patchSettings(ctx: ConsoleCtx) {
  need(ctx, "settings.manage");
  const values = ctx.body.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw err(400, "validation", "Send { values: { key: value } }.");
  const before = (await getSettings()) as unknown as Record<string, SettingValue>;
  const clean: Record<string, SettingValue> = {};
  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    const def = settingDef(key);
    if (!def) {
      fields[key] = `"${key}" isn't a setting you can change.`;
      continue;
    }
    const parsed = coerceSetting(def, raw);
    if (parsed.ok) {
      if (parsed.value !== before[key]) clean[key] = parsed.value;
    } else fields[key] = parsed.error;
  }
  if (Object.keys(fields).length) {
    const [field] = Object.keys(fields);
    throw err(400, "validation", fields[field], { field, fields });
  }
  const changed = Object.keys(clean);
  if (changed.length) {
    await saveSettings(clean, ctx.me.username, ctx.now);
    await logEvent("admin.settings", {
      actor: ctx.me,
      user: ctx.me,
      detail: { changed: changed.map((k) => `${k}: ${String(before[k])} → ${String(clean[k])}`) },
      now: ctx.now,
    });
  }
  const items = (await settingItems(ctx)).filter((i) => changed.includes(i.key as string));
  return json({ items, changed });
}

// ---- Security: visitors ----

interface VisitorAgg {
  ip: string;
  hits: number;
  first: number;
  last: number;
  days: number;
  country: string | null;
  city: string | null;
  network: string | null;
  asn: number | null;
  ua: string | null;
  username: string | null;
}

async function visitorData(since: number, now: number) {
  const [visits, strikes, signins, deny, allow] = await Promise.all([
    all<VisitorAgg>(
      `SELECT ip, COUNT(*) AS hits, MIN(at) AS first, MAX(at) AS last, COUNT(DISTINCT at / 86400000) AS days,
         MAX(country) AS country, MAX(city) AS city, MAX(network) AS network, MAX(asn) AS asn, MAX(user_agent) AS ua, MAX(username) AS username
       FROM visits WHERE at >= ? AND ip IS NOT NULL GROUP BY ip ORDER BY last DESC LIMIT 3000`,
      since,
    ),
    all<{ ip: string; kind: string; n: number; accounts: number; first: number; last: number }>(
      `SELECT ip, kind, COUNT(*) AS n, COUNT(DISTINCT subject) AS accounts, MIN(at) AS first, MAX(at) AS last
       FROM ip_strikes WHERE at >= ? GROUP BY ip, kind`,
      since,
    ),
    all<{ ip: string; username: string; user_id: number }>(
      `SELECT ip, MAX(username) AS username, MAX(user_id) AS user_id FROM events WHERE at >= ? AND type = 'signin.complete' AND ip IS NOT NULL GROUP BY ip`,
      since,
    ),
    listRules("deny"),
    listRules("allow"),
  ]);
  const map = new Map<string, VisitorAgg & { strikes: Partial<StrikeCounts>; refused: number }>();
  for (const v of visits) map.set(v.ip, { ...v, strikes: {}, refused: 0 });
  for (const s of strikes) {
    let entry = map.get(s.ip);
    if (!entry) {
      entry = { ip: s.ip, hits: 0, first: s.first, last: s.last, days: 1, country: null, city: null, network: null, asn: null, ua: null, username: null, strikes: {}, refused: 0 };
      map.set(s.ip, entry);
    }
    entry.first = Math.min(entry.first, s.first);
    entry.last = Math.max(entry.last, s.last);
    (entry.strikes as Record<string, number>)[s.kind] = s.n;
    if (s.kind === "failed_password" || s.kind === "failed_mfa") entry.strikes.accounts = Math.max(entry.strikes.accounts ?? 0, s.accounts);
    entry.refused += s.n;
  }
  const signedIn = new Map(signins.map((s) => [s.ip, s]));
  const liveDeny = deny.filter((r) => isLive(r, now));
  const liveAllow = allow.filter((r) => isLive(r, now));
  return [...map.values()].map((v) => {
    const { score, reasons } = threatScore(v.strikes);
    const denied = liveDeny.find((r) => ipInRange(v.ip, r.ip));
    const s = signedIn.get(v.ip);
    const refused = v.refused + (denied?.hits ?? 0);
    return {
      id: v.ip,
      ip: v.ip,
      score,
      band: threatBand(score),
      reasons,
      country: v.country,
      city: v.city,
      asn: v.asn,
      as_org: v.network,
      network: "unknown",
      hits: v.hits + refused,
      refused,
      allowed: v.hits,
      probe_hits: v.strikes.decoy ?? 0,
      first_seen: iso(v.first),
      last_seen: iso(v.last),
      days: v.days,
      signed_in: !!s,
      person: s ? { id: String(s.user_id), name: s.username, username: s.username } : null,
      on_allowlist: liveAllow.some((r) => ipInRange(v.ip, r.ip)),
      denied: !!denied,
      deny_id: denied ? String(denied.id) : null,
      user_agent: v.ua,
      device: v.ua ? describeDevice(v.ua) : null,
      decision: denied ? "block" : "allow",
      _last: v.last,
    };
  });
}

const BANDS = ["quiet", "watch", "suspicious", "hostile"];

export async function visitors(ctx: ConsoleCtx) {
  need(ctx, "security.view");
  const daysParam = ctx.query.get("days");
  const days = daysParam === "all" ? 90 : [1, 7, 14, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 7;
  const { limit, offset } = pageParams(ctx);
  let items = await visitorData(ctx.now - days * DAY, ctx.now);
  const band = ctx.query.get("band");
  if (band && BANDS.includes(band)) items = items.filter((i) => BANDS.indexOf(i.band) >= BANDS.indexOf(band));
  const min = Number(ctx.query.get("min_score"));
  if (min) items = items.filter((i) => i.score >= min);
  const country = ctx.query.get("country");
  if (country) items = items.filter((i) => i.country?.toUpperCase() === country.toUpperCase());
  const q = ctx.query.get("q")?.toLowerCase();
  if (q) items = items.filter((i) => [i.ip, i.city, i.as_org, i.user_agent, i.person?.username].some((v) => v?.toLowerCase().includes(q)));
  items.sort((a, b) => b.score - a.score || b._last - a._last);
  const totals = {
    ips: items.length,
    refused: items.reduce((s, i) => s + i.refused, 0),
    allowed: items.reduce((s, i) => s + i.allowed, 0),
    countries: new Set(items.map((i) => i.country).filter(Boolean)).size,
    hostile: items.filter((i) => i.band === "hostile").length,
  };
  const page = items.slice(offset, offset + limit).map(({ _last, ...rest }) => (void _last, rest));
  return json({
    days,
    windows: [1, 7, 14, 30, 90],
    totals,
    items: page,
    next_cursor: offset + limit < items.length ? String(offset + limit) : null,
  });
}

export async function visitorDetail(ctx: ConsoleCtx) {
  need(ctx, "security.view");
  const ip = ctx.params.id;
  const all90 = await visitorData(ctx.now - 90 * DAY, ctx.now);
  const found = all90.find((v) => v.ip === ip);
  if (!found) throw err(404, "not_found", `Nothing recorded from ${ip} in the last 90 days.`);
  const { _last, ...visitor } = found;
  void _last;
  const [paths, probes, accounts, recent] = await Promise.all([
    all<{ path: string; n: number }>("SELECT path, COUNT(*) AS n FROM visits WHERE ip = ? GROUP BY path ORDER BY n DESC LIMIT 20", ip),
    all<{ subject: string; kind: string; at: number }>("SELECT subject, kind, at FROM ip_strikes WHERE ip = ? ORDER BY at DESC LIMIT 50", ip),
    all<{ username: string; n: number }>(
      "SELECT username, COUNT(*) AS n FROM events WHERE ip = ? AND username IS NOT NULL GROUP BY username ORDER BY n DESC LIMIT 20",
      ip,
    ),
    first<{ language: string | null; time_zone: string | null; screen: string | null; user_agent: string | null }>(
      "SELECT language, time_zone, screen, user_agent FROM visits WHERE ip = ? ORDER BY id DESC LIMIT 1",
      ip,
    ),
  ]);
  return json({
    visitor,
    evidence: {
      reasons: visitor.reasons,
      paths: [...new Set(probes.filter((p) => p.kind === "decoy" || p.kind === "injection").map((p) => p.subject))].slice(0, 20),
    },
    sections: [
      {
        title: "Browser",
        rows: [
          ["User agent", recent?.user_agent ?? visitor.user_agent ?? "—"],
          ["Language", recent?.language ?? "—"],
          ["Time zone", recent?.time_zone ?? "—"],
          ["Window", recent?.screen ?? "—"],
        ],
      },
      { title: "Network", rows: [["Network", visitor.as_org ?? "—"], ["ASN", visitor.asn ? String(visitor.asn) : "—"], ["City", visitor.city ?? "—"], ["Country", visitor.country ?? "—"]] },
      { title: "Accounts seen from this IP", rows: accounts.length ? accounts.map((a) => [a.username, `${a.n} event${a.n === 1 ? "" : "s"}`]) : [["—", "none"]] },
      { title: "Pages visited", rows: paths.length ? paths.map((p) => [p.path, `${p.n}×`]) : [["—", "none"]] },
      { title: "Strikes", rows: probes.length ? probes.slice(0, 20).map((p) => [p.kind, `${p.subject ?? ""} · ${new Date(p.at).toISOString()}`]) : [["—", "none"]] },
    ],
  });
}

// ---- IP allowlist ----

function allowEntry(r: IpRule, now: number) {
  return {
    id: String(r.id),
    ip_or_cidr: r.ip,
    label: r.label,
    note: r.reason,
    status: r.revokedAt !== null ? "revoked" : r.expiresAt !== null && r.expiresAt <= now ? "expired" : "active",
    expires_at: iso(r.expiresAt),
    created_at: iso(r.createdAt),
    created_by: r.createdBy ? { id: String(r.createdBy), name: r.createdByUsername ?? String(r.createdBy) } : null,
    revoked_reason: r.revokedReason,
  };
}

function parseExpiry(raw: unknown, now: number): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const t = typeof raw === "number" ? raw : Date.parse(String(raw));
  if (!Number.isFinite(t)) throw err(400, "validation", `"${String(raw)}" isn't a date and time.`, { field: "expires_at" });
  if (t <= now) throw err(400, "validation", "The expiry must be in the future.", { field: "expires_at" });
  return t;
}

async function actorCoveredAfter(ctx: ConsoleCtx, excludeId: number | null, replacement?: string) {
  const settings = await getSettings();
  if (settings.allowlist_mode === "off") return true;
  const rules = (await listRules("allow")).filter((r) => isLive(r, ctx.now) && r.id !== excludeId);
  if (replacement) return ipInRange(ctx.ip, replacement) || rules.some((r) => ipInRange(ctx.ip, r.ip));
  return rules.some((r) => ipInRange(ctx.ip, r.ip));
}

export async function listAllow(ctx: ConsoleCtx) {
  need(ctx, "ips.view");
  const rules = await listRules("allow");
  const mine = rules.find((r) => isLive(r, ctx.now) && ipInRange(ctx.ip, r.ip));
  const settings = await getSettings();
  return json({
    items: rules.map((r) => allowEntry(r, ctx.now)),
    your_ip: ctx.ip,
    your_entry_id: mine ? String(mine.id) : null,
    can_manage: ctx.caps.has("ips.manage"),
    note:
      settings.allowlist_mode === "off"
        ? "The allowlist isn't enforced (Settings → Access). Entries mark trusted addresses. Being listed never exempts an address from auto-blacklisting."
        : `Enforced for ${settings.allowlist_mode === "admins" ? "admin and owner sign-ins" : "every sign-in"}. Being listed never exempts an address from auto-blacklisting.`,
  });
}

export async function addAllow(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const ip = String(ctx.body.ip_or_cidr ?? "").trim();
  const problem = rangeProblem(ip);
  if (problem) throw err(400, "validation", problem, { field: "ip_or_cidr" });
  const label = String(ctx.body.label ?? "").trim().slice(0, 100) || null;
  const note = String(ctx.body.note ?? ctx.body.owner ?? "").trim().slice(0, 300) || null;
  const expiresAt = parseExpiry(ctx.body.expires_at, ctx.now);
  const id = await addRule({ kind: "allow", ip: ip.toLowerCase(), label, reason: note, createdBy: ctx.me.id, expiresAt, now: ctx.now });
  await logEvent("admin.ip_allow_add", { actor: ctx.me, detail: { ip, label }, ip: ctx.ip, now: ctx.now });
  return json({ item: allowEntry((await findRule(id))!, ctx.now) }, 201);
}

async function loadRule(ctx: ConsoleCtx, kind: "allow" | "deny") {
  const rule = await findRule(idParam(ctx));
  if (!rule || rule.kind !== kind) throw err(404, "not_found", `There is no ${kind === "allow" ? "allowlist" : "deny-list"} entry ${ctx.params.id}.`);
  return rule;
}

export async function patchAllow(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const rule = await loadRule(ctx, "allow");
  if (rule.revokedAt !== null) throw err(409, "conflict", "That entry was revoked; add a new one instead.");
  if ("ip_or_cidr" in ctx.body && String(ctx.body.ip_or_cidr).trim() !== rule.ip) {
    const ip = String(ctx.body.ip_or_cidr).trim();
    const problem = rangeProblem(ip);
    if (problem) throw err(400, "validation", problem, { field: "ip_or_cidr" });
    if (!(await actorCoveredAfter(ctx, rule.id, ip))) throw err(400, "self_lockout", `Changing this entry would lock out your own address (${ctx.ip}).`, { field: "ip_or_cidr" });
    // An address change is a new entry: the old one is kept, revoked, for the record.
    await revokeRule(rule.id, ctx.me.id, `Replaced by ${ip}`, ctx.now);
    const id = await addRule({ kind: "allow", ip: ip.toLowerCase(), label: rule.label, reason: rule.reason, createdBy: ctx.me.id, expiresAt: rule.expiresAt, now: ctx.now });
    await logEvent("admin.ip_allow_update", { actor: ctx.me, detail: { from: rule.ip, to: ip }, now: ctx.now });
    return json({ item: allowEntry((await findRule(id))!, ctx.now) });
  }
  const changes: { label?: string | null; reason?: string | null; expiresAt?: number | null } = {};
  if ("label" in ctx.body) changes.label = ctx.body.label === null ? null : String(ctx.body.label).trim().slice(0, 100) || null;
  if ("note" in ctx.body) changes.reason = ctx.body.note === null ? null : String(ctx.body.note).trim().slice(0, 300) || null;
  if ("expires_at" in ctx.body) {
    changes.expiresAt = parseExpiry(ctx.body.expires_at, ctx.now);
  }
  await updateRule(rule.id, changes);
  await logEvent("admin.ip_allow_update", { actor: ctx.me, detail: { ip: rule.ip, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v ?? "cleared"])) }, now: ctx.now });
  return json({ item: allowEntry((await findRule(rule.id))!, ctx.now) });
}

export async function deleteAllow(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const rule = await loadRule(ctx, "allow");
  if (!(await actorCoveredAfter(ctx, rule.id))) {
    throw err(400, "self_lockout", `Removing this entry would lock out your own address (${ctx.ip}).`);
  }
  await revokeRule(rule.id, ctx.me.id, `Removed by ${ctx.me.username}`, ctx.now);
  await logEvent("admin.ip_allow_remove", { actor: ctx.me, detail: { ip: rule.ip }, now: ctx.now });
  return json({});
}

// ---- Deny list ----

function denyEntry(r: IpRule, now: number) {
  return {
    id: String(r.id),
    ip_or_cidr: r.ip,
    source: r.source,
    reason: r.reason,
    evidence: r.evidence,
    trigger: r.trigger,
    was_allowlisted: r.wasAllowlisted,
    owner_session: r.ownerSession,
    sessions_killed: r.sessionsKilled,
    created_at: iso(r.createdAt),
    created_by: r.createdBy ? { id: String(r.createdBy), name: r.createdByUsername ?? String(r.createdBy) } : null,
    expires_at: iso(r.expiresAt),
    hits: r.hits,
    status: r.revokedAt !== null ? "unblocked" : r.expiresAt !== null && r.expiresAt <= now ? "expired" : "active",
    unblocked_at: iso(r.revokedAt),
    unblocked_reason: r.revokedReason,
  };
}

export async function listDeny(ctx: ConsoleCtx) {
  need(ctx, "ips.view");
  const rules = await listRules("deny");
  // The kit lists active blocks; unblocked/expired history stays in the audit log.
  return json({ items: rules.filter((r) => isLive(r, ctx.now)).map((r) => denyEntry(r, ctx.now)), your_ip: ctx.ip, can_manage: ctx.caps.has("ips.manage") });
}

export async function addDeny(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const ip = String(ctx.body.ip_or_cidr ?? "").trim().toLowerCase();
  const problem = rangeProblem(ip);
  if (problem) throw err(400, "validation", problem, { field: "ip_or_cidr" });
  if (ipInRange(ctx.ip, ip)) throw err(400, "self_lockout", `Blocking ${ip} would lock out your own address (${ctx.ip}).`, { field: "ip_or_cidr" });
  if (isUnblockableIp(ip)) throw err(400, "validation", "That's this machine's own address.", { field: "ip_or_cidr" });
  const reason = String(ctx.body.reason ?? "").trim().slice(0, 300) || null;
  const expiresAt = parseExpiry(ctx.body.expires_at, ctx.now);
  // Sessions from the address end now (exact address; a range ends them on their next request).
  const { changes: killed } = await run("DELETE FROM sessions WHERE ip = ?", ip);
  const id = await addRule({ kind: "deny", ip, reason, createdBy: ctx.me.id, expiresAt, sessionsKilled: killed, now: ctx.now });
  await logEvent("admin.ip_deny_add", { actor: ctx.me, detail: { ip, reason, sessions_ended: killed }, now: ctx.now });
  return json({ item: denyEntry((await findRule(id))!, ctx.now) }, 201);
}

export async function patchDeny(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const rule = await loadRule(ctx, "deny");
  const changes: { reason?: string | null; expiresAt?: number | null } = {};
  if ("reason" in ctx.body) changes.reason = ctx.body.reason === null ? null : String(ctx.body.reason).trim().slice(0, 300) || null;
  if ("expires_at" in ctx.body) changes.expiresAt = parseExpiry(ctx.body.expires_at, ctx.now);
  await updateRule(rule.id, changes);
  await logEvent("admin.ip_deny_update", { actor: ctx.me, detail: { ip: rule.ip, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v ?? "cleared"])) }, now: ctx.now });
  return json({ item: denyEntry((await findRule(rule.id))!, ctx.now) });
}

export async function unblock(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const rule = await loadRule(ctx, "deny");
  if (rule.revokedAt !== null) throw err(409, "conflict", `${rule.ip} was already unblocked.`);
  await revokeRule(rule.id, ctx.me.id, `Unblocked by ${ctx.me.username}`, ctx.now);
  // Strikes that caused it would re-block on the next one; clear them.
  await run("DELETE FROM ip_strikes WHERE ip = ?", rule.ip);
  let readded = false;
  if (ctx.body.readd_allowlist === true) {
    if ((await matchingRules(rule.ip, "allow", ctx.now)).length === 0) {
      await addRule({ kind: "allow", ip: rule.ip, label: "Re-added after unblock", createdBy: ctx.me.id, now: ctx.now });
    }
    readded = true;
  }
  await logEvent("admin.ip_unblock", { actor: ctx.me, detail: { ip: rule.ip, source: rule.source, readded }, now: ctx.now });
  return json({ readded });
}

// ---- Sessions ----

export async function sessions(ctx: ConsoleCtx) {
  need(ctx, "sessions.view");
  const { limit, offset } = pageParams(ctx);
  const where = ["s.expires_at > ?"];
  const params: Param[] = [ctx.now];
  const person = Number(ctx.query.get("person"));
  if (person) {
    where.push("s.user_id = ?");
    params.push(person);
  }
  const q = ctx.query.get("q")?.toLowerCase();
  if (q) {
    where.push("(u.username_lower LIKE ? OR s.ip LIKE ? OR LOWER(s.city) LIKE ? OR LOWER(s.user_agent) LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    params.push(like, like, like, like);
  }
  const rows = await all<{ user_id: number; username: string; first_name: string; last_name: string }>(
    `SELECT DISTINCT s.user_id, u.username, u.first_name, u.last_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE ${where.join(" AND ")}`,
    ...params,
  );
  const items = [];
  for (const r of rows) {
    const list = await listSessions(r.user_id, ctx.now);
    for (const s of list) {
      const entry = sessionEntry(s, { id: r.user_id, username: r.username, firstName: r.first_name, lastName: r.last_name }, ctx.auth.session.idHash, ctx.now);
      if (q && ![r.username, s.ip, s.city, s.userAgent].some((v) => v?.toLowerCase().includes(q))) continue;
      items.push(entry);
    }
  }
  items.sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
  return json({ items: items.slice(offset, offset + limit), next_cursor: offset + limit < items.length ? String(offset + limit) : null, total: items.length });
}

export async function deleteSessionRoute(ctx: ConsoleCtx) {
  return revokeOneSession(ctx, ctx.params.id);
}

// ---- Country rule (PORTAL-STANDARD §9; shown as "Countries" on the IP allowlist page) ----

function describeRule(r: CountryRule): string {
  if (r.mode === "off" || r.countries.length === 0) return "no rule";
  return `${r.mode === "allow" ? "only" : "all but"} ${r.countries.join(", ")}`;
}

export async function getCountryRuleRoute(ctx: ConsoleCtx) {
  need(ctx, "ips.view");
  const rule = await getCountryRule();
  return json({
    mode: rule.mode,
    countries: rule.countries,
    modes: ["off", "allow", "deny"],
    presets: COUNTRY_PRESETS,
    notes: [
      "Applies to sign-in, account pages, the admin console and their APIs. The public pages stay open to everyone.",
      "Never overrides the IP allowlist: an allowlisted address is never refused for its country.",
      "An unknown country (no data, XX, or Tor) is never blocked. An empty list means no rule, never \"allow nobody\".",
      "Refused visitors are told exactly why, and each refused country sends at most one alert per 10 minutes.",
    ],
    your_country: await requestCountry(),
    can_manage: ctx.caps.has("ips.manage"),
  });
}

export async function putCountryRule(ctx: ConsoleCtx) {
  need(ctx, "ips.manage");
  const parsed = parseCountryRule(ctx.body);
  if (!parsed.ok) throw err(400, "validation", parsed.error, { field: parsed.field });
  const rule = parsed.rule;
  const mine = await requestCountry();
  if (mine && countryRefused(rule, mine) && !(await isAllowlisted(ctx.ip))) {
    throw err(
      400,
      "self_lockout",
      `This rule would refuse your own country, ${countryName(mine)} (${mine}), and your address ${ctx.ip} isn't on the IP allowlist. Add your address to the allowlist first, or include ${mine}.`,
    );
  }
  const before = await getCountryRule();
  await saveCountryRule(rule, ctx.me.username, ctx.now);
  if (describeRule(before) !== describeRule(rule) || before.mode !== rule.mode) {
    await logEvent("admin.country_rule", { actor: ctx.me, user: ctx.me, detail: { from: describeRule(before), to: describeRule(rule) }, now: ctx.now });
  }
  return json({ mode: rule.mode, countries: rule.countries });
}
