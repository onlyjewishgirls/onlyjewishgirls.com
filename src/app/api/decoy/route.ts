import type { NextRequest } from "next/server";
import { logEvent } from "@/server/events";
import { clientIp } from "@/server/http";
import { recordStrike } from "@/server/threat";

/**
 * Scanner and decoy paths (/.env, /wp-admin, /.git/, /phpmyadmin, *.php …) are
 * rewritten here by next.config.ts. Nobody legitimate asks for them, so one hit
 * auto-blacklists the address (PORTAL-STANDARD §7). Answers a plain 404.
 */
async function handle(req: NextRequest) {
  const path = `/${(req.nextUrl.searchParams.get("p") ?? "").slice(0, 200)}`;
  const ip = clientIp(req);
  await logEvent("security.decoy", { detail: { path, method: req.method } });
  await recordStrike("decoy", { ip, subject: path, evidence: `${req.method} ${path}` });
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
export const HEAD = handle;
