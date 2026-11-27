import "server-only";
import { UNKNOWN_NAMES_THRESHOLD, isUnblockableIp, threatBand, threatScore, type StrikeCounts } from "@/lib/security";
import type { Settings } from "@/lib/settings-schema";
import { securityAlert } from "./alerts";
import { all, first, run } from "./db";
import { logEvent, requestInfo } from "./events";
import { addRule, matchingRules, revokeRule, type IpRule } from "./ip-rules";
import { getSettings } from "./settings";

/**
 * PORTAL-STANDARD §7: suspicious activity from an address — allowlisted or
 * not — gets it blocked automatically. Each suspicious thing is a "strike";
 * after each one the address's recent strikes are checked against the
 * thresholds in Settings.
 */

export type StrikeKind = "failed_password" | "failed_mfa" | "admin_denied" | "rate_limit" | "decoy" | "injection";

export type AutoBlockTrigger =
  | "failed_logins"
  | "failed_mfa"
  | "multi_account"
  | "hostile_score"
  | "decoy"
  | "admin_denied"
  | "injection"
  | "rate_limit";

const STRIKE_RETENTION_MS = 7 * 86_400_000;
/** An auto-block is emailed when someone signed in successfully from the address within this long. */
export const SIGNED_IN_RECENTLY_MS = 24 * 60 * 60_000;

export async function strikeCounts(ip: string, since: number): Promise<StrikeCounts> {
  const rows = await all<{ kind: string; n: number; accounts: number }>(
    `SELECT kind, COUNT(*) AS n, COUNT(DISTINCT subject) AS accounts FROM ip_strikes
     WHERE ip = ? AND at >= ? GROUP BY kind`,
    ip,
    since,
  );
  const counts: StrikeCounts = { failed_password: 0, failed_mfa: 0, accounts: 0, admin_denied: 0, rate_limit: 0, decoy: 0, injection: 0 };
  // PORTAL-STANDARD §7 "Failed sign-ins from one address across several accounts": real accounts
  // ("u<id>") and names that match no account ("name:<hash>") are counted apart. A successful sign-in
  // settles that account's earlier failures from the address (events.ts deletes those strikes; the
  // audit log keeps them). A passkey this site doesn't know ("passkey:unknown") is neither.
  const accountSubjects = await first<{ n: number; unknown: number }>(
    `SELECT COUNT(DISTINCT CASE WHEN subject LIKE 'u%' THEN subject END) AS n,
            COUNT(DISTINCT CASE WHEN subject LIKE 'name:%' THEN subject END) AS unknown
     FROM ip_strikes WHERE ip = ? AND at >= ? AND kind IN ('failed_password', 'failed_mfa')`,
    ip,
    since,
  );
  for (const row of rows) {
    if (row.kind in counts) counts[row.kind as keyof StrikeCounts] = row.n;
  }
  counts.accounts = accountSubjects?.n ?? 0;
  counts.unknown_names = accountSubjects?.unknown ?? 0;
  return counts;
}

/** Which threshold, if any, the counts cross. Pure; exported for tests. */
export function crossedThreshold(
  c: StrikeCounts,
  s: Pick<
    Settings,
    | "auto_block_failed_passwords"
    | "auto_block_failed_mfa"
    | "auto_block_accounts"
    | "auto_block_admin_denied"
    | "auto_block_rate_limits"
    | "auto_block_hostile_score"
    | "auto_block_window_minutes"
  >,
): { trigger: AutoBlockTrigger; reason: string } | null {
  const w = `${s.auto_block_window_minutes} min`;
  if (c.injection > 0) return { trigger: "injection", reason: "Sent an injection or path-traversal payload." };
  if (c.decoy > 0) return { trigger: "decoy", reason: "Requested a scanner/decoy path." };
  // Several accounts first: when 5 people each mistyped once, that (not "5 wrong passwords") is what happened.
  if (c.accounts >= s.auto_block_accounts)
    return { trigger: "multi_account", reason: `Failed sign-ins against ${c.accounts} different accounts in ${w}.` };
  if ((c.unknown_names ?? 0) >= UNKNOWN_NAMES_THRESHOLD)
    return { trigger: "multi_account", reason: `Failed sign-ins for ${c.unknown_names} usernames that don't exist in ${w}.` };
  if (c.failed_password >= s.auto_block_failed_passwords)
    return { trigger: "failed_logins", reason: `${c.failed_password} wrong passwords in ${w}.` };
  if (c.failed_mfa >= s.auto_block_failed_mfa)
    return { trigger: "failed_mfa", reason: `${c.failed_mfa} wrong two-step codes in ${w}.` };
  if (c.admin_denied >= s.auto_block_admin_denied)
    return { trigger: "admin_denied", reason: `${c.admin_denied} admin requests without permission in ${w}.` };
  if (c.rate_limit >= s.auto_block_rate_limits)
    return { trigger: "rate_limit", reason: `Hit rate limits ${c.rate_limit} times in ${w}.` };
  const { score } = threatScore(c);
  if (score >= s.auto_block_hostile_score)
    return { trigger: "hostile_score", reason: `Threat score reached ${score} (hostile band).` };
  return null;
}

function evidenceLines(c: StrikeCounts, extra: string[]): string[] {
  const lines = [...extra];
  const add = (n: number, text: string) => n > 0 && lines.push(text);
  add(c.failed_password, `${c.failed_password} wrong password${c.failed_password === 1 ? "" : "s"}`);
  add(c.failed_mfa, `${c.failed_mfa} wrong two-step code${c.failed_mfa === 1 ? "" : "s"}`);
  add(c.accounts > 1 ? c.accounts : 0, `${c.accounts} different accounts tried`);
  add((c.unknown_names ?? 0) > 1 ? (c.unknown_names ?? 0) : 0, `${c.unknown_names} usernames that don't exist tried`);
  add(c.admin_denied, `${c.admin_denied} refused admin request${c.admin_denied === 1 ? "" : "s"}`);
  add(c.rate_limit, `${c.rate_limit} rate-limit trip${c.rate_limit === 1 ? "" : "s"}`);
  add(c.decoy, `${c.decoy} decoy/scanner request${c.decoy === 1 ? "" : "s"}`);
  add(c.injection, `${c.injection} injection attempt${c.injection === 1 ? "" : "s"}`);
  return lines.slice(0, 20);
}

/**
 * Records one strike and, if a threshold is crossed, blocks the address.
 * Returns the deny entry when this strike caused (or the address already had) a block.
 */
export async function recordStrike(
  kind: StrikeKind,
  options: { ip?: string | null; subject?: string | null; evidence?: string; now?: number } = {},
): Promise<IpRule | null> {
  const now = options.now ?? Date.now();
  const ip = options.ip ?? (await requestInfo()).ip;
  if (!ip) return null;
  try {
    await run("INSERT INTO ip_strikes (ip, kind, subject, at) VALUES (?, ?, ?, ?)", ip, kind, options.subject ?? null, now);
    if (Math.random() < 0.02) await run("DELETE FROM ip_strikes WHERE at < ?", now - STRIKE_RETENTION_MS);
    const settings = await getSettings();
    const counts = await strikeCounts(ip, now - settings.auto_block_window_minutes * 60_000);
    const before = threatScore({ ...counts, [kind]: Math.max(0, (counts as unknown as Record<string, number>)[kind] - 1) }).score;
    const after = threatScore(counts);
    if (threatBand(after.score) === "hostile" && threatBand(before) !== "hostile") {
      const id = await logEvent("security.hostile", { detail: { ip, score: after.score, reasons: after.reasons }, now });
      await securityAlert({
        event: "hostile_visitor",
        title: "Visitor reached the hostile threat band",
        key: ip,
        what: `${ip} reached threat score ${after.score}: ${after.reasons.join("; ")}.`,
        ip,
        auditId: id,
      });
    }
    if (!settings.auto_block_enabled) return null;
    const crossed = crossedThreshold(counts, settings);
    if (!crossed) return null;
    return await autoBlock(ip, crossed.trigger, crossed.reason, evidenceLines(counts, options.evidence ? [options.evidence] : []), settings, now);
  } catch (error) {
    // Detection must never break the request it watches.
    console.error("Strike recording failed:", error);
    return null;
  }
}

/** §7 steps 1–5: off the allowlist, onto the deny list, sessions killed, audited, alerted. */
export async function autoBlock(
  ip: string,
  trigger: AutoBlockTrigger,
  reason: string,
  evidence: string[],
  settings: Settings,
  now = Date.now(),
): Promise<IpRule | null> {
  const existing = await matchingRules(ip, "deny", now);
  if (existing.length) return existing[0];
  if (isUnblockableIp(ip)) {
    // Local development and tests: report, never block the machine itself.
    await logEvent("security.auto_block_skipped", { detail: { ip, trigger, reason, evidence }, now });
    return null;
  }

  // 1. Off the allowlist (entries are kept, marked revoked, so the history shows what happened).
  const allowed = await matchingRules(ip, "allow", now);
  for (const entry of allowed) await revokeRule(entry.id, null, `Auto-blacklisted: ${reason}`, now);

  // Owner lockout safety: still block, but say so loudly.
  const owner = await first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.ip = ? AND u.role = 'owner' AND s.stage = 'full' AND s.expires_at > ?`,
    ip,
    now,
  );
  const ownerSession = (owner?.n ?? 0) > 0;
  // Whether a real person signed in from here in the last 24 hours: then the block is emailed (§6), naming
  // them, because it may be a member or admin flagged by mistake. Read before the sessions are ended.
  // The audit log's sign-ins first; a fully signed-in session from the address covers the rest.
  const signedIn = await first<{ username: string; at: number }>(
    `SELECT username, at FROM (
       SELECT username, at FROM events
        WHERE type = 'signin.complete' AND ip = ?1 AND at > ?2 AND username IS NOT NULL
       UNION ALL
       SELECT u.username, s.created_at AS at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.ip = ?1 AND s.stage = 'full' AND s.created_at > ?2
     ) ORDER BY at DESC LIMIT 1`,
    ip,
    now - SIGNED_IN_RECENTLY_MS,
  );

  // 3. Kill every session from the address.
  const { changes: killed } = await run("DELETE FROM sessions WHERE ip = ?", ip);

  // 2. Onto the deny list.
  const expiresAt = settings.auto_block_minutes > 0 ? now + settings.auto_block_minutes * 60_000 : null;
  const id = await addRule({
    kind: "deny",
    ip,
    source: "auto",
    reason,
    trigger,
    evidence,
    wasAllowlisted: allowed.length > 0,
    ownerSession,
    sessionsKilled: killed,
    expiresAt,
    now,
  });

  // 4. Audit.
  const auditId = await logEvent("security.auto_blocked", {
    detail: { ip, trigger, reason, evidence, was_allowlisted: allowed.length > 0, owner_session: ownerSession, sessions_killed: killed, rule: id, signed_in: signedIn?.username ?? null },
    now,
  });

  // 5. Alert.
  await securityAlert({
    event: "auto_blacklist",
    title: ownerSession ? "Auto-blacklisted the owner's IP" : "IP auto-blacklisted",
    key: ip,
    what: `${ip} was blocked automatically: ${reason}`,
    details: [
      ["Trigger", trigger],
      ["Evidence", evidence.join("; ") || "—"],
      ["Was on allowlist", allowed.length ? `yes (${allowed.map((a) => a.ip).join(", ")}; now revoked)` : "no"],
      ["Sessions ended", String(killed)],
      ["Block lasts", expiresAt ? `until ${new Date(expiresAt).toISOString()}` : "until unblocked"],
    ],
    ip,
    ownerLockout: ownerSession,
    wasAllowlisted: allowed.length > 0,
    signedIn: signedIn ?? null,
    auditId,
    now,
  });
  return (await matchingRules(ip, "deny", now))[0] ?? null;
}
