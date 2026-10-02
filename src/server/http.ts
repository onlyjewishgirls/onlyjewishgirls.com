import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ConfigError } from "./app-secret";

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export function tooManyRequests(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
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

/** Wraps a POST route handler with the origin check and a generic error response. */
export function api(handler: Handler): Handler {
  return async (req) => {
    if (!sameOrigin(req)) return jsonError(403, "Request blocked: it didn't come from this site.");
    try {
      return await handler(req);
    } catch (error) {
      console.error(error);
      if (error instanceof ConfigError) {
        return jsonError(500, `This site isn't fully set up yet: ${error.message}`);
      }
      return jsonError(500, "Something went wrong. Please try again.");
    }
  };
}
