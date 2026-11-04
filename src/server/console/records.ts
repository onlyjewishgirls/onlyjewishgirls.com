import "server-only";
import { eventLabel, isWarningEvent } from "@/lib/admin/events";
import { canRevert } from "@/lib/admin/permissions";
import { listEvents, type AdminEvent } from "../admin";
import { applyUndo, parseUndo, undoAction } from "../admin-undo";
import { currentRouting, listAlerts, recordAndSend, type AlertRow } from "../alerts";
import { all, first, run, type Param } from "../db";
import { logEvent } from "../events";
import { findUserById } from "../users";
import { err, idParam, iso, json, need, pageParams, type ConsoleCtx } from "./core";

// ---- Audit log ----

function category(type: string): string {
  if (type.startsWith("signin.") || type === "signout") return "auth";
  if (type.startsWith("mfa.") || type.startsWith("password.")) return "auth";
  if (type.startsWith("streak.") || type === "admin.set_streak" || type === "admin.grant_restores") return "streaks";
  if (type.startsWith("security.") || type.startsWith("admin.ip_")) return "security";
  if (type === "admin.settings" || type === "admin.alert_test") return "settings";
  if (type === "admin.set_role" || type === "admin.set_permissions") return "roles";
  if (type === "admin.revoke_session" || type === "admin.sign_out_everywhere") return "sessions";
  if (type === "admin.revert") return "audit";
  return "people";
}

function outcome(type: string): "success" | "failure" | "denied" {
  if (["signin.failed", "signin.unknown", "signin.mfa_failed", "streak.restore_refused"].includes(type)) return "failure";
  if (
    type.startsWith("security.") ||
    ["signin.rate_limited", "signin.mfa_locked", "signin.suspended", "signin.locked", "signin.ip_blocked", "signin.ip_not_allowed"].includes(type)
  )
    return "denied";
  return "success";
}

function severity(type: string): "info" | "notice" | "warning" | "critical" {
  if (type === "security.auto_blocked" || type === "security.hostile" || type === "admin.delete") return "critical";
  if (isWarningEvent(type)) return "warning";
  if (type.startsWith("admin.")) return "notice";
  return "info";
}

function sentence(e: AdminEvent): string {
  const d = e.detail ?? {};
  const bits = Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && (typeof v !== "object" || Array.isArray(v)))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`);
  return `${eventLabel(e.type)}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
}

export function auditEntry(e: AdminEvent) {
  const changes =
    e.detail && "from" in e.detail && "to" in e.detail ? [{ field: e.type.replace(/^admin\./, ""), before: e.detail.from, after: e.detail.to }] : undefined;
  return {
    id: String(e.id),
    ts: iso(e.at),
    action: e.type,
    detail: sentence(e),
    category: category(e.type),
    severity: severity(e.type),
    outcome: outcome(e.type),
    actor: e.actorId !== null || e.actorUsername ? { id: String(e.actorId ?? ""), name: e.actorUsername ?? "(deleted)", username: e.actorUsername } : null,
    target: e.userId !== null || e.username ? { type: "person", id: String(e.userId ?? ""), label: e.username ?? "(deleted)" } : null,
    ip: e.ip,
    country: e.country,
    user_agent: e.userAgent,
    changes,
    revertible: e.undoable,
    reverted_at: iso(e.revertedAt),
    reverted_by: e.revertedBy ? { id: "", name: e.revertedBy } : null,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  auth: "Sign-in & two-step",
  people: "People",
  roles: "Roles & permissions",
  security: "Security",
  sessions: "Sessions",
  settings: "Settings",
  streaks: "Streaks",
  audit: "Audit",
};

const CATEGORY_SQL: Record<string, string> = {
  auth: "(type LIKE 'signin.%' OR type = 'signout' OR type LIKE 'mfa.%' OR type LIKE 'password.%')",
  streaks: "(type LIKE 'streak.%' OR type IN ('admin.set_streak', 'admin.grant_restores'))",
  security: "(type LIKE 'security.%' OR type LIKE 'admin.ip_%')",
  settings: "type IN ('admin.settings', 'admin.alert_test')",
  roles: "type IN ('admin.set_role', 'admin.set_permissions')",
  sessions: "type IN ('admin.revoke_session', 'admin.sign_out_everywhere')",
  audit: "type = 'admin.revert'",
  people:
    "(type LIKE 'admin.%' AND type NOT IN ('admin.set_streak','admin.grant_restores','admin.settings','admin.alert_test','admin.set_role','admin.set_permissions','admin.revoke_session','admin.sign_out_everywhere','admin.revert') AND type NOT LIKE 'admin.ip_%' OR type = 'account.created')",
};

export async function listAudit(ctx: ConsoleCtx) {
  need(ctx, "audit.view");
  const { limit } = pageParams(ctx);
  const where: string[] = [];
  const params: Param[] = [];
  const cat = ctx.query.get("category");
  if (cat && CATEGORY_SQL[cat]) where.push(CATEGORY_SQL[cat]);
  const q = ctx.query.get("q")?.trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      "(LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(actor_username) LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR LOWER(detail) LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like, like, like);
  }
  const action = ctx.query.get("action");
  if (action) {
    where.push("type = ?");
    params.push(action);
  }
  const actor = ctx.query.get("actor");
  if (actor) {
    where.push("(actor_id = ? OR LOWER(actor_username) = ?)");
    params.push(Number(actor) || -1, actor.toLowerCase());
  }
  const target = ctx.query.get("target");
  if (target) {
    where.push("(user_id = ? OR LOWER(username) = ?)");
    params.push(Number(target) || -1, target.toLowerCase());
  }
  const from = ctx.query.get("from");
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push("at >= ?");
    params.push(Date.parse(`${from}T00:00:00Z`));
  }
  const to = ctx.query.get("to");
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push("at < ?");
    params.push(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
  }
  const cursor = Number(ctx.query.get("cursor"));
  if (cursor > 0) {
    where.push("id < ?");
    params.push(cursor);
  }
  const rows = await all<Parameters<typeof toAdminEvent>[0]>(
    `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  let items = rows.slice(0, limit).map(toAdminEvent).map(auditEntry);
  const severityFilter = ctx.query.get("severity");
  if (severityFilter) items = items.filter((i) => i.severity === severityFilter);
  const outcomeFilter = ctx.query.get("outcome");
  if (outcomeFilter) items = items.filter((i) => i.outcome === outcomeFilter);
  // Link each entry to the alert it emailed.
  const ids = items.map((i) => Number(i.id));
  const alerts = ids.length
    ? await all<{ id: number; audit_id: number }>(
        `SELECT id, audit_id FROM security_alerts WHERE audit_id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      )
    : [];
  const alertBy = new Map(alerts.map((a) => [a.audit_id, String(a.id)]));
  return json({
    items: items.map((i) => ({ ...i, alert_id: alertBy.get(Number(i.id)) ?? null })),
    next_cursor: rows.length > limit ? String(rows[limit - 1].id) : null,
    filters: { categories: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })) },
    can_revert: ctx.caps.has("audit.revert"),
    chained: false,
  });
}

function toAdminEvent(row: {
  id: number;
  at: number;
  type: string;
  user_id: number | null;
  username: string | null;
  actor_id: number | null;
  actor_username: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  detail: string | null;
  undo: string | null;
  reverted_at: number | null;
  reverted_by: string | null;
}): AdminEvent {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = row.detail ? JSON.parse(row.detail) : null;
  } catch {
    detail = null;
  }
  return {
    id: row.id,
    at: row.at,
    type: row.type,
    userId: row.user_id,
    username: row.username,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    ip: row.ip,
    userAgent: row.user_agent,
    country: row.country,
    detail,
    undoable: row.undo !== null && row.reverted_at === null,
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
  };
}

export async function recentSecurityEvents(limit = 15) {
  const rows = await all<Parameters<typeof toAdminEvent>[0]>(
    `SELECT * FROM events WHERE type IN ('signin.failed','signin.unknown','signin.mfa_failed','signin.rate_limited','signin.mfa_locked',
       'signin.suspended','signin.locked','signin.ip_blocked','signin.ip_not_allowed','admin.suspend','admin.delete','admin.lock')
       OR type LIKE 'security.%' ORDER BY id DESC LIMIT ?`,
    limit,
  );
  return rows.map(toAdminEvent).map(auditEntry);
}

export async function revertAudit(ctx: ConsoleCtx) {
  need(ctx, "audit.revert");
  const id = idParam(ctx);
  const row = await first<{ id: number; type: string; user_id: number | null; undo: string | null; reverted_at: number | null }>(
    "SELECT id, type, user_id, undo, reverted_at FROM events WHERE id = ?",
    id,
  );
  const undo = parseUndo(row?.undo ?? null);
  if (!row || !undo) throw err(404, "not_found", "That entry can't be reverted.");
  if (row.reverted_at !== null) throw err(409, "conflict", "That change was already reverted.");
  const target = row.user_id === null ? null : await findUserById(row.user_id);
  if (!target) throw err(404, "not_found", "That account doesn't exist anymore.");
  if (!canRevert(ctx.me, undoAction(undo), target)) throw err(403, "forbidden", "You can't revert changes to this account.");
  const claim = await run("UPDATE events SET reverted_at = ?, reverted_by = ? WHERE id = ? AND reverted_at IS NULL", ctx.now, ctx.me.username, row.id);
  if (claim.changes !== 1) throw err(409, "conflict", "That change was already reverted.");
  let problem: string | null;
  try {
    problem = await applyUndo(target, undo);
  } catch (e) {
    await run("UPDATE events SET reverted_at = NULL, reverted_by = NULL WHERE id = ?", row.id);
    throw e;
  }
  if (problem) {
    await run("UPDATE events SET reverted_at = NULL, reverted_by = NULL WHERE id = ?", row.id);
    throw err(409, "conflict", problem);
  }
  await logEvent("admin.revert", { user: target, actor: ctx.me, detail: { event: row.id, change: row.type }, now: ctx.now });
  return json({ note: `Reverted: ${eventLabel(row.type)} on ${target.username}.` });
}

export async function recentEvents(ctx: ConsoleCtx) {
  need(ctx, "overview.view");
  return json({ items: await recentSecurityEvents(Math.min(50, Number(ctx.query.get("limit")) || 15)), next_cursor: null });
}

// ---- Security alerts ----

function alertEntry(a: AlertRow) {
  return {
    id: String(a.id),
    ts: iso(a.at),
    event: a.event,
    subject: a.subject,
    to: a.to_addr,
    from: a.from_addr,
    status: a.status,
    provider: a.provider?.toLowerCase() ?? null,
    error: a.error,
    dedupe_key: a.dedupe_key,
    suppressed: a.suppressed,
    ip: a.ip,
    person: a.user_id ? { id: String(a.user_id), name: a.username ?? String(a.user_id), username: a.username } : null,
    audit_id: a.audit_id ? String(a.audit_id) : null,
    owner_lockout: a.owner_lockout === 1,
  };
}

export async function listAlertsRoute(ctx: ConsoleCtx) {
  need(ctx, "alerts.view");
  const { limit } = pageParams(ctx);
  const before = Number(ctx.query.get("cursor")) || undefined;
  const { rows, more } = await listAlerts({
    status: ctx.query.get("status") ?? undefined,
    event: ctx.query.get("event") ?? undefined,
    q: ctx.query.get("q") ?? undefined,
    before,
    limit,
  });
  return json({
    items: rows.map(alertEntry),
    next_cursor: more ? String(rows[rows.length - 1].id) : null,
    routing: currentRouting(ctx.req.nextUrl.host),
  });
}

export async function testAlert(ctx: ConsoleCtx) {
  need(ctx, "alerts.test");
  const auditId = await logEvent("admin.alert_test", { actor: ctx.me, user: ctx.me, now: ctx.now });
  const info = { ip: ctx.ip, country: null, userAgent: ctx.req.headers.get("user-agent") };
  const id = await recordAndSend(
    {
      event: "test",
      title: "Test alert",
      key: `test:${ctx.now}`,
      what: `${ctx.me.username} sent a test alert from the console.`,
      user: ctx.me,
      actor: ctx.me,
      ...info,
      auditId,
      now: ctx.now,
    },
    ctx.req.nextUrl.host,
  );
  const row = await first<AlertRow>("SELECT * FROM security_alerts WHERE id = ?", id ?? -1);
  return json({ alert: row ? alertEntry(row) : null });
}

export { alertEntry, listEvents };
