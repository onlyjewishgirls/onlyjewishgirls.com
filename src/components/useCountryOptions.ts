"use client";

import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import { useMemo, useSyncExternalStore } from "react";

/** Shown first, with fixed names so the server and browser render identical HTML. */
const PINNED_COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["IL", "Israel"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
];

const noopSubscribe = () => () => {};
const callingCode = (code: string) => getCountryCallingCode(code as Parameters<typeof getCountryCallingCode>[0]);

export function useCountryOptions() {
  // Country names come from the runtime's ICU data, which differs between Node and browsers
  // ("Hong Kong SAR China" vs "Hong Kong"), so the full list is only built after hydration.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return useMemo(() => {
    const pinned = PINNED_COUNTRIES.map(([code, name]) => ({ code, label: `${name} (+${callingCode(code)})` }));
    if (!hydrated) return pinned;
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const rest = getCountries()
      .filter((c) => !PINNED_COUNTRIES.some(([p]) => p === c))
      .map((code) => ({ code, label: `${names.of(code) ?? code} (+${callingCode(code)})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...pinned, ...rest];
  }, [hydrated]);
}

