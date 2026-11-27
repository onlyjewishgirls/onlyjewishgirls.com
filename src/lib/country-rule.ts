/**
 * The country rule (PORTAL-STANDARD §9). Pure: unit-tested directly.
 * `allow` = only the listed countries; `deny` = the listed countries are refused.
 * An empty list is no rule, an unknown country is never blocked, and an address on
 * the IP allowlist is never subject to it (the caller checks that).
 */

export type CountryMode = "off" | "allow" | "deny";
export interface CountryRule {
  mode: CountryMode;
  countries: string[];
}

export const NO_RULE: CountryRule = { mode: "off", countries: [] };

export const COUNTRY_PRESETS: { label: string; mode: CountryMode; countries: string[] }[] = [
  { label: "United States only", mode: "allow", countries: ["US"] },
  { label: "US and Canada", mode: "allow", countries: ["US", "CA"] },
  { label: "US, Canada and Israel", mode: "allow", countries: ["US", "CA", "IL"] },
  { label: "No rule", mode: "off", countries: [] },
];

/** Cloudflare's "unknown" (XX) and Tor (T1) codes, or no country at all. */
export function isUnknownCountry(code: string | null | undefined): boolean {
  return !code || code === "XX" || code === "T1" || !/^[A-Z]{2}$/.test(code);
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A real ISO 3166 alpha-2 country this runtime knows (not ZZ "Unknown Region", XX, T1 or EU). */
export function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code) || ["XX", "T1", "ZZ", "EU", "UN"].includes(code)) return false;
  const name = countryName(code);
  return name !== code && !/^Unknown/i.test(name);
}

/** Whether the rule refuses this country (ignoring the allowlist exemption). */
export function countryRefused(rule: CountryRule, country: string | null | undefined): boolean {
  if (rule.mode === "off" || rule.countries.length === 0 || isUnknownCountry(country)) return false;
  const listed = rule.countries.includes(country!.toUpperCase());
  return rule.mode === "allow" ? !listed : listed;
}

export function countryBlockedMessage(country: string): string {
  return `Sign-in from ${countryName(country)} (${country}) is not allowed on this site.`;
}

/** Validates a rule from the console. Returns an error sentence or the clean rule. */
export function parseCountryRule(body: { mode?: unknown; countries?: unknown }): { ok: true; rule: CountryRule } | { ok: false; field: string; error: string } {
  const mode = body.mode;
  if (mode !== "off" && mode !== "allow" && mode !== "deny") return { ok: false, field: "mode", error: 'Mode must be "off", "allow" or "deny".' };
  if (!Array.isArray(body.countries)) return { ok: false, field: "countries", error: "Send countries as a list of two-letter codes." };
  const countries = [...new Set(body.countries.map((c) => String(c).trim().toUpperCase()))].sort();
  const bad = countries.filter((c) => !isCountryCode(c));
  if (bad.length) return { ok: false, field: "countries", error: `Not a country code: ${bad.join(", ")}.` };
  if (countries.length > 250) return { ok: false, field: "countries", error: "That's more countries than exist." };
  return { ok: true, rule: { mode, countries: mode === "off" ? [] : countries } };
}
