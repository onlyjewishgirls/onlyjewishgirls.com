import "server-only";
import { settingsFromRows, type Settings, type SettingValue } from "@/lib/settings-schema";
import { all, batch, type Statement } from "./db";

/** Every setting, stored values over defaults. One small query; the table has a dozen rows. */
export async function getSettings(): Promise<Settings> {
  return settingsFromRows(await all<{ key: string; value: string }>("SELECT key, value FROM settings"));
}

export async function saveSettings(values: Record<string, SettingValue>, by: string | null, now = Date.now()) {
  const statements: Statement[] = Object.entries(values).map(([key, value]) => [
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key,
    JSON.stringify(value),
    now,
    by,
  ]);
  if (statements.length) await batch(statements);
}
