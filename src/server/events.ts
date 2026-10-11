import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import type { EventType } from "@/lib/admin/events";
import { run } from "./db";

/** Kept for a year, then deleted (checked at most once an hour per Worker instance). */
const RETENTION_MS = 365 * 24 * 60 * 60_000;
let lastPrunedAt = 0;

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
}

/** Where the current request came from. Cloudflare sets CF-Connecting-IP and the cf location. */
export async function requestInfo(): Promise<RequestInfo> {
  const h = await headers();
  let cf: { country?: string; city?: string } | undefined;
  try {
    cf = getCloudflareContext().cf as typeof cf;
  } catch {
    cf = undefined;
  }
  return {
    ip: h.get("cf-connecting-ip"),
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
  };
}

interface Subject {
  id: number;
  username: string;
}

/**
 * Records something that happened. Logging never breaks the action it
 * describes: a failure here is reported and otherwise ignored.
 */
export async function logEvent(
  type: EventType,
  options: {
    user?: Subject | null;
    actor?: Subject | null;
    detail?: Record<string, unknown>;
    /** For admin changes that can be undone from the activity log: what to put back. */
    undo?: Record<string, unknown>;
    now?: number;
  } = {},
) {
  const now = options.now ?? Date.now();
  try {
    const info = await requestInfo();
    await run(
      `INSERT INTO events (at, type, user_id, username, actor_id, actor_username, ip, user_agent, country, detail, undo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now,
      type,
      options.user?.id ?? null,
      options.user?.username ?? null,
      options.actor?.id ?? null,
      options.actor?.username ?? null,
      info.ip,
      info.userAgent,
      info.country,
      options.detail ? JSON.stringify(options.detail) : null,
      options.undo ? JSON.stringify(options.undo) : null,
    );
    if (now - lastPrunedAt > 60 * 60_000) {
      lastPrunedAt = now;
      await run("DELETE FROM events WHERE at < ?", now - RETENTION_MS);
    }
  } catch (error) {
    console.error(`Couldn't record ${type} event:`, error);
  }
}
