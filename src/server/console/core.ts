import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { hasPermission, isAdminRole, ROLE_LABELS } from "@/lib/admin/permissions";
import { ConfigError } from "../app-secret";
import { adminDenied } from "../admin";
import { clientIp, ipBlockedMessage } from "../http";
import { checkCountry, recordCountryRefusal } from "../country-rule";
import { denyingRule } from "../ip-rules";
import { mfaState, nextStep } from "../mfa";
import { rateLimit } from "../rate-limit";
import { getAuth, recentlyVerified, type AuthContext } from "../session";
import type { User } from "../users";

/**
 * Shared plumbing for the Console kit's JSON API (/api/console/*, contract in
 * console-kit/API.md). Every endpoint goes through `consoleHandler`, so the
 * auth, CSRF, deny-list, step-up and rate-limit checks can't be skipped.
 */

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "same-origin" };

export const REVERIFY_URL = "/admin/verify?next=/admin";

export class ConsoleError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConsoleError(status, code, message, extra);

export function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ok: true, ...body }, { status, headers: NO_STORE });
}

export interface ConsoleCtx {
  req: NextRequest;
  auth: AuthContext;
  me: User;
  isOwner: boolean;
  caps: Set<string>;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  now: number;
  ip: string;
}

/** The viewer's canonical console capabilities (API.md §1), from this site's owner/admin model. */
export function capabilitiesFor(user: User): string[] {
  if (!isAdminRole(user.role)) return [];
  const caps = [
    "overview.view",
    "people.view",
    "people.create",
    "people.edit",
    "people.status",
    "people.delete",
    "people.password",
    "people.mfa",
    "people.email",
    "roles.view",
    "streaks.view",
    "settings.view",
    "security.view",
    "ips.view",
    "sessions.view",
    "sessions.revoke",
    "audit.view",
    "alerts.view",
  ];
  if (hasPermission(user, "streaks.manage")) caps.push("streaks.manage");
  if (user.role === "owner") {
    caps.push("people.role", "people.permissions", "settings.manage", "ips.manage", "audit.revert", "alerts.test");
  }
  return caps;
}

export function need(ctx: ConsoleCtx, cap: string) {
  if (!ctx.caps.has(cap)) {
    throw err(403, "forbidden", `You need the "${cap}" permission for this. ${ctx.isOwner ? "" : "Ask the owner."}`.trim(), { perm: cap });
  }
}

export function roleRef(user: User) {
  return { value: user.role, label: ROLE_LABELS[user.role], tone: user.role === "owner" ? "danger" : user.role === "admin" ? "info" : null };
}

export const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function personRef(u: { id: number; username: string; firstName?: string; lastName?: string } | null) {
  if (!u) return null;
  const name = u.firstName ? `${u.firstName} ${u.lastName ?? ""}`.trim() : u.username;
  return { id: String(u.id), name, username: u.username };
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

type Handler = (ctx: ConsoleCtx) => Promise<Response>;

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  /** Changes something: needs a second factor in the last 15 minutes (step-up). */
  write?: boolean;
}

function match(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = segments[i];
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

function errorResponse(e: ConsoleError) {
  return NextResponse.json(
    { ok: false, code: e.code, error: e.message, ...e.extra },
    { status: e.status, headers: NO_STORE },
  );
}

export async function dispatch(req: NextRequest, segments: string[], routes: Route[]): Promise<Response> {
  const method = req.method.toUpperCase();
  try {
    const candidates = routes.filter((r) => match(r.pattern, segments));
    const route = candidates.find((r) => r.method === method);
    if (!route) {
      if (candidates.length) throw err(405, "method_not_allowed", `${method} isn't supported on /api/console/${segments.join("/")}.`);
      throw err(404, "not_found", `There is no console endpoint /api/console/${segments.join("/")}.`);
    }
    const ip = clientIp(req);
    if (method !== "GET") {
      if (req.headers.get("x-requested-with") !== "console" || !sameOrigin(req)) {
        throw err(403, "csrf", "Request blocked: it didn't come from this site's console. Reload the page.");
      }
    }
    const denied = await denyingRule(ip);
    if (denied) throw err(403, "ip_blocked", ipBlockedMessage(ip, denied));
    const country = await checkCountry(ip);
    if (!country.ok) {
      await recordCountryRefusal(country, req.nextUrl.pathname);
      throw err(403, "country_blocked", country.message);
    }
    const auth = await getAuth();
    if (!auth || auth.session.stage !== "full") throw err(401, "unauthenticated", "Your sign-in expired. Sign in again.");
    if (!isAdminRole(auth.user.role)) {
      await adminDenied(auth.user, `console ${method} /${segments.join("/")}`, ip);
      throw err(404, "not_found", "Not found.");
    }
    const next = nextStep("full", await mfaState(auth.user), auth.user.mustChangePassword);
    if (next !== "/home") throw err(403, "forbidden", "Finish signing in first: set up two-step sign-in and choose your own password.");

    const now = Date.now();
    let body: Record<string, unknown> = {};
    if (method !== "GET" && method !== "DELETE") {
      const text = await req.text();
      if (text.length > 64 * 1024) throw err(413, "validation", "That request is larger than 64 KB.");
      try {
        const parsed = text ? JSON.parse(text) : {};
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        throw err(400, "validation", "The request body isn't valid JSON.");
      }
    }
    if (route.write) {
      if (!recentlyVerified(auth.session, now)) {
        throw err(403, "step_up_required", "Confirm it's you (passkey or authenticator app) before making changes. It lasts 15 minutes.", {
          reverify_url: REVERIFY_URL,
        });
      }
      const limit = await rateLimit(`admin:${auth.user.id}`, 300, 60 * 60_000, now);
      if (!limit.ok) throw err(429, "rate_limited", `That's 300 changes in an hour. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} min.`);
    }
    const ctx: ConsoleCtx = {
      req,
      auth,
      me: auth.user,
      isOwner: auth.user.role === "owner",
      caps: new Set(capabilitiesFor(auth.user)),
      params: match(route.pattern, segments)!,
      query: req.nextUrl.searchParams,
      body,
      now,
      ip,
    };
    return await route.handler(ctx);
  } catch (e) {
    if (e instanceof ConsoleError) return errorResponse(e);
    console.error(e);
    if (e instanceof ConfigError) return errorResponse(err(500, "config", `This site isn't fully set up yet: ${e.message}`));
    return errorResponse(err(500, "server_error", `The server hit an error: ${(e as Error)?.message ?? String(e)}`));
  }
}

// ---- Small input helpers ----

export const bodyStr = (ctx: ConsoleCtx, key: string) => (typeof ctx.body[key] === "string" ? (ctx.body[key] as string) : "");

export function pageParams(ctx: ConsoleCtx) {
  const limit = Math.min(200, Math.max(1, Number(ctx.query.get("limit")) || 50));
  const offset = Math.max(0, Number(ctx.query.get("cursor")) || 0);
  return { limit, offset };
}

export function idParam(ctx: ConsoleCtx, key = "id"): number {
  const n = Number(ctx.params[key]);
  if (!Number.isSafeInteger(n) || n <= 0) throw err(404, "not_found", `"${ctx.params[key]}" isn't a valid id.`);
  return n;
}
