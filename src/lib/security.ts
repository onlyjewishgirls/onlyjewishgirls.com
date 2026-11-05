/**
 * Pure helpers for PORTAL-STANDARD §6 (alert routing) and §7 (suspicious
 * activity): IP/CIDR matching, the registrable domain of a host, decoy paths
 * and injection signatures. No I/O, so it is unit-tested directly.
 */

// ---- IP addresses and CIDR ranges ----

// BigInt() calls rather than B0 literals: the project's TypeScript target is below ES2020.
const B0 = BigInt(0);
const B1 = BigInt(1);
const B8 = BigInt(8);
const B16 = BigInt(16);
const LOW32 = BigInt(0xffffffff);

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = B0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << B8) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(":")) return null;
  let head = ip;
  let tail4: bigint | null = null;
  // IPv4-mapped tail, e.g. ::ffff:1.2.3.4
  const lastColon = ip.lastIndexOf(":");
  if (ip.slice(lastColon + 1).includes(".")) {
    tail4 = ipv4ToBigInt(ip.slice(lastColon + 1));
    if (tail4 === null) return null;
    head = `${ip.slice(0, lastColon)}:0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  let n = B0;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << B16) | BigInt(parseInt(g, 16));
  }
  if (tail4 !== null) n = (n & ~LOW32) | tail4;
  return n;
}

export interface ParsedRange {
  version: 4 | 6;
  base: bigint;
  prefix: number;
  /** Canonical text (as typed, trimmed and lowercased). */
  text: string;
}

/** Parses "1.2.3.4", "1.2.3.0/24", "2001:db8::/32". Returns null when malformed. */
export function parseIpRange(input: string): ParsedRange | null {
  const text = input.trim().toLowerCase();
  const [addr, prefixText, extra] = text.split("/");
  if (extra !== undefined || !addr) return null;
  const v4 = ipv4ToBigInt(addr);
  const version = v4 !== null ? 4 : 6;
  const value = v4 ?? ipv6ToBigInt(addr);
  if (value === null) return null;
  const bits = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const mask = prefix === 0 ? B0 : ((B1 << BigInt(prefix)) - B1) << BigInt(bits - prefix);
  return { version, base: value & mask, prefix, text };
}

/** Why an allow/deny entry would be refused, or null if it's fine. */
export function rangeProblem(input: string): string | null {
  const r = parseIpRange(input);
  if (!r) return `"${input.trim()}" is not an IP address or CIDR range.`;
  if (r.prefix === 0) return "A /0 range would cover the whole internet.";
  if (r.version === 4 && r.prefix < 8) return "Ranges wider than /8 are refused.";
  if (r.version === 6 && r.prefix < 16) return "IPv6 ranges wider than /16 are refused.";
  return null;
}

export function ipInRange(ip: string, range: string): boolean {
  const r = parseIpRange(range);
  const a = parseIpRange(ip);
  if (!r || !a || a.version !== r.version) return false;
  const bits = r.version === 4 ? 32 : 128;
  const mask = r.prefix === 0 ? B0 : ((B1 << BigInt(r.prefix)) - B1) << BigInt(bits - r.prefix);
  return (a.base & mask) === r.base;
}

/** Addresses we never auto-block: unknown, or the machine itself (local development and tests). */
export function isUnblockableIp(ip: string | null | undefined): boolean {
  if (!ip || ip === "unknown") return true;
  return ip === "::1" || ip.startsWith("127.") || ip === "::ffff:127.0.0.1";
}

// ---- Registrable domain ("apex") ----

/** Second-level suffixes where the registrable domain has three labels. Small on purpose. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.il", "org.il", "net.il", "ac.il", "gov.il", "muni.il",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "co.jp", "com.mx", "co.in", "com.sg",
]);

/** `wamv.chaimyuirmafia.com` → `chaimyuirmafia.com`. Ports and a trailing dot are ignored. */
export function apexDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h || /^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const labels = h.split(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
}

export interface AlertEnv {
  ALERTS_EMAIL_FROM?: string;
  ALERTS_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
}

export interface AlertRouting {
  from: string;
  to: string;
  from_source: "env" | "legacy_env" | "default";
  to_source: "env" | "legacy_env" | "default";
}

/** §6: new names win, then the older names, then securityalerts@ / soc@ the apex. */
export function alertRouting(env: AlertEnv, host: string): AlertRouting {
  const apex = apexDomain(host);
  const pick = (current: string | undefined, legacy: string | undefined, fallback: string) =>
    current?.trim()
      ? { value: current.trim(), source: "env" as const }
      : legacy?.trim()
        ? { value: legacy.trim(), source: "legacy_env" as const }
        : { value: fallback, source: "default" as const };
  const from = pick(env.ALERTS_EMAIL_FROM, env.ALERT_EMAIL_FROM, `securityalerts@${apex}`);
  const to = pick(env.ALERTS_EMAIL_TO, env.ALERT_EMAIL_TO, `soc@${apex}`);
  return { from: from.value, to: to.value, from_source: from.source, to_source: to.source };
}

// ---- Decoys and injection signatures ----

/** Paths nobody legitimate asks this site for. A hit is a scanner (§7). */
export const DECOY_PATH_PATTERNS: RegExp[] = [
  /^\/\.env(\.|\/|$)/i,
  /^\/\.git(\/|$)/i,
  /^\/\.svn(\/|$)/i,
  /^\/\.aws(\/|$)/i,
  /^\/\.ds_store$/i,
  /^\/wp-(admin|login|content|includes|config)/i,
  /^\/xmlrpc\.php/i,
  /^\/phpmyadmin/i,
  /^\/pma(\/|$)/i,
  /^\/adminer/i,
  /^\/cgi-bin\//i,
  /^\/server-status/i,
  /^\/vendor\/phpunit/i,
  /^\/config\.(php|json|yml|yaml)$/i,
  /^\/[^/]*\.(php|asp|aspx|jsp|cgi)$/i,
  /^\/administrator(\/|$)/i,
  /^\/actuator(\/|$)/i,
];

export function isDecoyPath(path: string): boolean {
  return DECOY_PATH_PATTERNS.some((re) => re.test(path));
}

const INJECTION_SIGNATURES: { name: string; re: RegExp }[] = [
  { name: "path traversal", re: /(\.\.\/|\.\.\\|%2e%2e(%2f|%5c|\/))/i },
  { name: "script tag", re: /<\s*script/i },
  { name: "javascript: URL", re: /javascript\s*:/i },
  { name: "SQL tautology", re: /'\s*(or|and)\s+['"\d\w]+\s*=\s*['"\d\w]+/i },
  { name: "SQL UNION", re: /union(\s|\/\*.*?\*\/)+(all\s+)?select/i },
  { name: "SQL comment", re: /'\s*;?\s*--/ },
  { name: "SQL stacked query", re: /;\s*(drop|delete|insert|update)\s+/i },
  { name: "template injection", re: /\$\{jndi:|\{\{.*\}\}/i },
  { name: "null byte", re: /%00|\u0000/ },
];

/** The first injection signature found in any of the values, or null. */
export function findInjection(values: string[]): { name: string; sample: string } | null {
  for (const raw of values) {
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // keep the raw text
    }
    for (const sig of INJECTION_SIGNATURES) {
      if (sig.re.test(value) || sig.re.test(raw)) return { name: sig.name, sample: raw.slice(0, 120) };
    }
  }
  return null;
}

// ---- Threat score ----

export type ThreatBand = "quiet" | "watch" | "suspicious" | "hostile";

export function threatBand(score: number): ThreatBand {
  if (score >= 80) return "hostile";
  if (score >= 50) return "suspicious";
  if (score >= 20) return "watch";
  return "quiet";
}

export interface StrikeCounts {
  failed_password: number;
  failed_mfa: number;
  accounts: number;
  admin_denied: number;
  rate_limit: number;
  decoy: number;
  injection: number;
}

/** Points per strike kind; capped at 100. Decoys and injections alone reach the hostile band. */
export function threatScore(c: Partial<StrikeCounts>): { score: number; reasons: string[] } {
  const parts: [number, string][] = [];
  const add = (n: number | undefined, weight: number, label: (n: number) => string) => {
    if (n && n > 0) parts.push([n * weight, label(n)]);
  };
  add(c.decoy, 80, (n) => `${n} request${n === 1 ? "" : "s"} to scanner/decoy paths`);
  add(c.injection, 80, (n) => `${n} injection attempt${n === 1 ? "" : "s"}`);
  add(c.failed_password, 10, (n) => `${n} wrong password${n === 1 ? "" : "s"}`);
  add(c.failed_mfa, 10, (n) => `${n} wrong two-step code${n === 1 ? "" : "s"}`);
  add(c.accounts && c.accounts > 1 ? c.accounts : 0, 15, (n) => `failed sign-ins on ${n} accounts`);
  add(c.admin_denied, 20, (n) => `${n} refused admin request${n === 1 ? "" : "s"}`);
  add(c.rate_limit, 15, (n) => `${n} rate-limit trip${n === 1 ? "" : "s"}`);
  parts.sort((a, b) => b[0] - a[0]);
  return { score: Math.min(100, parts.reduce((s, [p]) => s + p, 0)), reasons: parts.map(([, r]) => r) };
}

/** "4 min 12 s", "1 h 5 min", "35 s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return r ? `${m} min ${r} s` : `${m} min`;
  return `${r} s`;
}

/** "jane@example.com" → "ja•••@example.com": enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
}
