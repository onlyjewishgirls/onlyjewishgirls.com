import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { countryBlockedMessage, countryRefused, isUnknownCountry, NO_RULE, type CountryRule } from "@/lib/country-rule";
import { first, run } from "./db";
import { isAllowlisted } from "./ip-rules";

const KEY = "country_rule";

export async function getCountryRule(): Promise<CountryRule> {
  const row = await first<{ value: string }>("SELECT value FROM settings WHERE key = ?", KEY);
  try {
    const v = row ? JSON.parse(row.value) : null;
    if (v && (v.mode === "allow" || v.mode === "deny" || v.mode === "off") && Array.isArray(v.countries)) {
      return { mode: v.mode, countries: v.countries.map(String) };
    }
  } catch {
    // a corrupt row means no rule
  }
  return NO_RULE;
}

export async function saveCountryRule(rule: CountryRule, by: string, now = Date.now()) {
  // Lives in the settings table (no schema change); not one of the typed Settings items.
  await run(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    KEY,
    JSON.stringify(rule),
    now,
    by,
  );
}

/** The request's country: Cloudflare's request.cf.country, else the CF-IPCountry header. */
export async function requestCountry(): Promise<string | null> {
  let cf: { country?: string } | undefined;
  try {
    cf = getCloudflareContext().cf as typeof cf;
  } catch {
    cf = undefined;
  }
  const code = cf?.country ?? (await headers()).get("cf-ipcountry");
  return code ? code.toUpperCase() : null;
}

export type CountryCheck = { ok: true } | { ok: false; country: string; message: string };

/**
 * PORTAL-STANDARD §9, for sign-in, account and admin routes (never public pages). An address on
 * the IP allowlist is never refused, nor is an unknown country.
 */
export async function checkCountry(ip: string | null): Promise<CountryCheck> {
  const country = await requestCountry();
  if (isUnknownCountry(country)) return { ok: true };
  const rule = await getCountryRule();
  if (!countryRefused(rule, country)) return { ok: true };
  if (await isAllowlisted(ip)) return { ok: true };
  return { ok: false, country: country!, message: countryBlockedMessage(country!) };
}

/** API paths the country rule covers: sign-in, account, MFA, admin and console. Sign-out stays open. */
export function countryGuardedPath(path: string): boolean {
  if (path === "/api/auth/logout") return false;
  return /^\/(api\/(auth|mfa|admin|streak|console)(\/|$)|admin(\/|$))/.test(path);
}

/** Records the refusal; the audit entry sends the alert (deduped per country per 10 minutes). */
export async function recordCountryRefusal(check: Extract<CountryCheck, { ok: false }>, path: string) {
  const { logEvent } = await import("./events");
  await logEvent("signin.country_blocked", { detail: { country: check.country, path } });
}
