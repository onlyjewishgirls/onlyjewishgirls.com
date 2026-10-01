import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { MIGRATIONS } from "./schema";

/** Values D1 can bind. Booleans must be passed as 0/1. */
export type Param = string | number | null;
export type Statement = [sql: string, ...params: Param[]];

let migrated = false;

async function currentVersion(d1: D1Database): Promise<number> {
  const row = await d1.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").first<{ v: number }>();
  return row?.v ?? 0;
}

async function migrate(d1: D1Database) {
  await d1
    .prepare("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
    .run();
  for (let version = await currentVersion(d1); version < MIGRATIONS.length; version++) {
    try {
      await d1.batch([
        ...MIGRATIONS[version].map((sql) => d1.prepare(sql)),
        d1.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").bind(version + 1, Date.now()),
      ]);
    } catch (error) {
      // Another Worker instance may have applied this migration at the same moment.
      if ((await currentVersion(d1)) <= version) throw error;
    }
  }
}

async function database(): Promise<D1Database> {
  const d1 = getCloudflareContext().env.DB;
  if (!migrated) {
    await migrate(d1);
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
