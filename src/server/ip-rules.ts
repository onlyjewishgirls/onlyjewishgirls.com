import "server-only";
import { ipInRange } from "@/lib/security";
import { all, first, run } from "./db";

export interface IpRule {
  id: number;
  kind: "allow" | "deny";
  ip: string;
  label: string | null;
  source: "manual" | "auto";
  reason: string | null;
  trigger: string | null;
  evidence: string[];
  wasAllowlisted: boolean;
  ownerSession: boolean;
  sessionsKilled: number;
  hits: number;
  createdAt: number;
  createdBy: number | null;
  createdByUsername: string | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedBy: number | null;
  revokedReason: string | null;
}

interface IpRuleRow {
  id: number;
  kind: "allow" | "deny";
  ip: string;
  label: string | null;
  source: "manual" | "auto";
  reason: string | null;
  trigger_kind: string | null;
  evidence: string | null;
  was_allowlisted: number;
  owner_session: number;
  sessions_killed: number;
  hits: number;
  created_at: number;
  created_by: number | null;
  created_by_username?: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: number | null;
  revoked_reason: string | null;
}

function toRule(row: IpRuleRow): IpRule {
  let evidence: string[] = [];
  try {
    const parsed = row.evidence ? JSON.parse(row.evidence) : [];
    evidence = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    kind: row.kind,
    ip: row.ip,
    label: row.label,
    source: row.source,
    reason: row.reason,
    trigger: row.trigger_kind,
    evidence,
    wasAllowlisted: row.was_allowlisted === 1,
    ownerSession: row.owner_session === 1,
    sessionsKilled: row.sessions_killed,
    hits: row.hits,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByUsername: row.created_by_username ?? null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
  };
}

const SELECT = `SELECT r.*, u.username AS created_by_username FROM ip_rules r LEFT JOIN users u ON u.id = r.created_by`;

/** Every rule of a kind, live ones first. */
export async function listRules(kind: "allow" | "deny"): Promise<IpRule[]> {
  const rows = await all<IpRuleRow>(`${SELECT} WHERE r.kind = ? ORDER BY r.revoked_at IS NOT NULL, r.id DESC LIMIT 1000`, kind);
  return rows.map(toRule);
}

export async function findRule(id: number): Promise<IpRule | null> {
  const row = await first<IpRuleRow>(`${SELECT} WHERE r.id = ?`, id);
  return row ? toRule(row) : null;
}

export function isLive(rule: IpRule, now = Date.now()): boolean {
  return rule.revokedAt === null && (rule.expiresAt === null || rule.expiresAt > now);
}

/** Live rules of a kind that cover the address. */
export async function matchingRules(ip: string, kind: "allow" | "deny", now = Date.now()): Promise<IpRule[]> {
  const rows = await all<IpRuleRow>(
    `${SELECT} WHERE r.kind = ? AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > ?)
       AND (r.ip = ? OR r.ip LIKE '%/%')`,
    kind,
    now,
    ip.trim().toLowerCase(),
  );
  return rows.map(toRule).filter((r) => ipInRange(ip, r.ip));
}

/** The deny entry blocking this address, if any; counts the refused request. */
export async function denyingRule(ip: string | null, now = Date.now()): Promise<IpRule | null> {
  if (!ip) return null;
  const [rule] = await matchingRules(ip, "deny", now);
  if (rule) await run("UPDATE ip_rules SET hits = hits + 1 WHERE id = ?", rule.id);
  return rule ?? null;
}

export async function isAllowlisted(ip: string | null, now = Date.now()): Promise<boolean> {
  return !!ip && (await matchingRules(ip, "allow", now)).length > 0;
}

export async function addRule(rule: {
  kind: "allow" | "deny";
  ip: string;
  label?: string | null;
  source?: "manual" | "auto";
  reason?: string | null;
  trigger?: string | null;
  evidence?: string[];
  wasAllowlisted?: boolean;
  ownerSession?: boolean;
  sessionsKilled?: number;
  createdBy?: number | null;
  expiresAt?: number | null;
  now?: number;
}): Promise<number> {
  const { lastRowId } = await run(
    `INSERT INTO ip_rules (kind, ip, label, source, reason, trigger_kind, evidence, was_allowlisted, owner_session,
                           sessions_killed, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rule.kind,
    rule.ip,
    rule.label ?? null,
    rule.source ?? "manual",
    rule.reason ?? null,
    rule.trigger ?? null,
    rule.evidence ? JSON.stringify(rule.evidence) : null,
    rule.wasAllowlisted ? 1 : 0,
    rule.ownerSession ? 1 : 0,
    rule.sessionsKilled ?? 0,
    rule.now ?? Date.now(),
    rule.createdBy ?? null,
    rule.expiresAt ?? null,
  );
  return lastRowId;
}

export async function updateRule(id: number, changes: { label?: string | null; reason?: string | null; expiresAt?: number | null }) {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if ("label" in changes) {
    sets.push("label = ?");
    params.push(changes.label ?? null);
  }
  if ("reason" in changes) {
    sets.push("reason = ?");
    params.push(changes.reason ?? null);
  }
  if ("expiresAt" in changes) {
    sets.push("expires_at = ?");
    params.push(changes.expiresAt ?? null);
  }
  if (sets.length) await run(`UPDATE ip_rules SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
}

export async function revokeRule(id: number, by: number | null, reason: string | null, now = Date.now()) {
  await run(
    "UPDATE ip_rules SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL",
    now,
    by,
    reason,
    id,
  );
}
