import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { applyMigrations } from "./schema";

/** Values D1 can bind. Booleans must be passed as 0/1. */
export type Param = string | number | null;
export type Statement = [sql: string, ...params: Param[]];

let migrated = false;

async function database(): Promise<D1Database> {
  const d1 = getCloudflareContext().env.DB;
  if (!migrated) {
    await applyMigrations(d1);
    migrated = true;
  }
  return d1;
}

export async function first<T>(sql: string, ...params: Param[]): Promise<T | null> {
  return (await database()).prepare(sql).bind(...params).first<T>();
}

export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  return (await (await database()).prepare(sql).bind(...params).all<T>()).results;
}

export async function run(sql: string, ...params: Param[]): Promise<{ changes: number; lastRowId: number }> {
  const { meta } = await (await database()).prepare(sql).bind(...params).run();
  return { changes: meta.changes, lastRowId: meta.last_row_id };
}

/** Runs the statements atomically: all succeed or none do. */
export async function batch(statements: Statement[]): Promise<void> {
  const d1 = await database();
  await d1.batch(statements.map(([sql, ...params]) => d1.prepare(sql).bind(...params)));
}
