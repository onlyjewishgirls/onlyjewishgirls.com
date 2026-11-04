import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { findInjection, formatDuration } from "@/lib/security";
import { ConfigError } from "./app-secret";
import { logEvent } from "./events";
import { denyingRule } from "./ip-rules";
import { recordStrike } from "./threat";

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/**
 * PORTAL-STANDARD §2: `{ ok:false, code, field, error }`, where `error` is the exact sentence
 * the form shows (under `field`, or as a banner when there is none).
 */
export function fail(status: number, code: string, error: string, field?: string | null, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, code, field: field ?? null, error, ...extra }, { status });
}

/** States the limit exactly, and counts as a rate-limit strike against the address (§7). */
export async function tooManyRequests(retryAfterSeconds: number, ip?: string | null, what = "attempts") {
  const address = ip ?? (await currentIp());
  await recordStrike("rate_limit", { ip: address, subject: what });
  return NextResponse.json(
    {
      ok: false,
      code: "rate_limited",
      field: null,
      error: `Too many ${what} from ${address ?? "your address"}. Try again in ${formatDuration(retryAfterSeconds)}.`,
      retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

async function currentIp(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("cf-connecting-ip");
  } catch {
    return null;
  }
}

/** §2 `ip_blocked`: the exact sentence for a deny-listed address. */
export function ipBlockedMessage(ip: string, rule: { reason: string | null; expiresAt: number | null }) {
  const until = rule.expiresAt ? ` until ${new Date(rule.expiresAt).toUTCString()}` : "";
  return `Your IP ${ip} is blocked${until} (reason: ${rule.reason ?? "blocked by an administrator"}).`;
}

/** CSRF protection: state-changing requests must come from a page on the same site. */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === new URL(req.url).origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/**
 * Used only for rate limiting. Cloudflare sets CF-Connecting-IP to the real
 * client address and overwrites any value a client sends.
 */
export function clientIp(req: NextRequest): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Reads a JSON object body (max 64 KB). Returns {} for anything else. */
export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 64 * 1024) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type Handler = (req: NextRequest) => Promise<Response>;

/** Body fields checked for injection signatures. Passwords, codes and free text are never inspected. */
const INSPECTED_FIELDS = ["identifier", "username", "email", "firstName", "middleName", "lastName", "phone", "timeZone", "q", "path"];

/**
 * Injection / traversal signatures in the query string or the identifying body fields (§7).
 * Returns a refusal response when found; the strike itself blocks the address.
 */
export async function checkInjection(req: NextRequest, body?: Record<string, unknown>): Promise<Response | null> {
  const values = [...req.nextUrl.searchParams.values(), req.nextUrl.pathname];
  if (body) for (const key of INSPECTED_FIELDS) if (typeof body[key] === "string") values.push(body[key] as string);
  const hit = findInjection(values);
  if (!hit) return null;
  const ip = clientIp(req);
  await logEvent("security.injection", { detail: { signature: hit.name, sample: hit.sample, path: req.nextUrl.pathname } });
  await recordStrike("injection", { ip, subject: req.nextUrl.pathname, evidence: `${hit.name}: ${hit.sample}` });
  return fail(400, "injection", `Refused: the request contains a ${hit.name} pattern ("${hit.sample}").`);
}

/** Wraps a POST route handler with the origin check, the deny list, the injection check and an error response. */
export function api(handler: Handler): Handler {
  return async (req) => {
    if (!sameOrigin(req)) return fail(403, "csrf", "Request blocked: it didn't come from this site.");
    try {
      const ip = clientIp(req);
      const denied = await denyingRule(ip);
      if (denied) return fail(403, "ip_blocked", ipBlockedMessage(ip, denied));
      let body: Record<string, unknown> | undefined;
      try {
        const text = await req.clone().text();
        const value = text && text.length <= 64 * 1024 ? JSON.parse(text) : undefined;
        body = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
      } catch {
        body = undefined;
      }
      const injected = await checkInjection(req, body);
      if (injected) return injected;
      return await handler(req);
    } catch (error) {
      console.error(error);
      if (error instanceof ConfigError) {
        return fail(500, "config", `This site isn't fully set up yet: ${error.message}`);
      }
      return fail(500, "server_error", `The server hit an error: ${(error as Error)?.message ?? String(error)}`);
    }
  };
}
