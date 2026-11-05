/**
 * Admin settings (PORTAL-STANDARD §4, §7 and the console's Settings section).
 * Pure data shared by the server (which stores and validates) and tests.
 */

export interface SettingDef {
  key: string;
  group: "streaks" | "auto_block" | "access" | "general";
  label: string;
  description: string;
  type: "int" | "bool" | "select" | "timezone";
  default: number | boolean | string;
  min?: number;
  max?: number;
  unit?: string;
  options?: { value: string; label: string; description?: string }[];
  danger?: boolean;
  confirm?: string;
}

export const SETTING_GROUPS = [
  { key: "streaks", label: "Streaks", description: "Courtesy restores for people who lost their 🔥 streak." },
  {
    key: "auto_block",
    label: "Auto-blacklist",
    description:
      "IP addresses that do something suspicious are taken off the allowlist, put on the deny list, and signed out, with no human step. An alert email goes out every time.",
  },
  { key: "access", label: "Access", description: "Who may sign in from where." },
  { key: "general", label: "General", description: "Time zone used for months, alerts and the console." },
] as const;

export const SETTINGS: SettingDef[] = [
  {
    key: "streak_restores",
    group: "streaks",
    label: "Courtesy restores per month",
    description: "How many times a person can restore their own lost streak each calendar month. 0 turns courtesy restores off.",
    type: "int",
    default: 3,
    min: 0,
    max: 31,
  },
  {
    key: "auto_block_enabled",
    group: "auto_block",
    label: "Auto-blacklist suspicious IPs",
    description: "Applies to allowlisted addresses too: being on the allowlist does not exempt an address from detection.",
    type: "bool",
    default: true,
    danger: true,
    confirm: "Turn automatic blocking off? Attacks will then only be reported, not stopped.",
  },
  {
    key: "auto_block_window_minutes",
    group: "auto_block",
    label: "Detection window",
    description: "The counts below are measured over this many minutes.",
    type: "int",
    default: 15,
    min: 1,
    max: 1440,
    unit: "minutes",
  },
  {
    key: "auto_block_failed_passwords",
    group: "auto_block",
    label: "Wrong passwords from one IP",
    description: "Block an address after this many wrong passwords in the window.",
    type: "int",
    default: 5,
    min: 2,
    max: 1000,
  },
  {
    key: "auto_block_failed_mfa",
    group: "auto_block",
    label: "Wrong two-step codes from one IP",
    description: "Block after this many wrong passkey, authenticator or recovery-code attempts in the window.",
    type: "int",
    default: 5,
    min: 2,
    max: 1000,
  },
  {
    key: "auto_block_accounts",
    group: "auto_block",
    label: "Different accounts tried from one IP",
    description: "Block after failed sign-ins against this many different accounts (or unknown names) in the window.",
    type: "int",
    default: 3,
    min: 2,
    max: 1000,
  },
  {
    key: "auto_block_admin_denied",
    group: "auto_block",
    label: "Admin requests without permission",
    description: "Block after this many refused requests to the admin console or its API in the window.",
    type: "int",
    default: 3,
    min: 1,
    max: 1000,
  },
  {
    key: "auto_block_rate_limits",
    group: "auto_block",
    label: "Rate-limit trips",
    description: "Block after hitting a rate limit this many times in the window.",
    type: "int",
    default: 3,
    min: 1,
    max: 1000,
  },
  {
    key: "auto_block_hostile_score",
    group: "auto_block",
    label: "Hostile threat score",
    description: "Block an address whose threat score reaches this (80 is the start of the hostile band).",
    type: "int",
    default: 80,
    min: 50,
    max: 100,
  },
  {
    key: "auto_block_minutes",
    group: "auto_block",
    label: "Block duration",
    description: "How long an automatic block lasts. 0 = permanent, until someone clicks Unblock.",
    type: "int",
    default: 0,
    min: 0,
    max: 525600,
    unit: "minutes",
  },
  {
    key: "allowlist_mode",
    group: "access",
    label: "Enforce the IP allowlist",
    description:
      "Off: the allowlist only marks trusted addresses. Admins: admin and owner accounts may only sign in from allowlisted addresses. Everyone: nobody may sign in from an address that isn't on it.",
    type: "select",
    default: "off",
    options: [
      { value: "off", label: "Off" },
      { value: "admins", label: "Admins and owner only" },
      { value: "everyone", label: "Everyone" },
    ],
    danger: true,
    confirm: "Enforce the allowlist? Anyone covered who is not on it will be refused at sign-in.",
  },
  {
    key: "mfa_default_method",
    group: "access",
    label: "Default two-step method",
    description: "Which method the verification screen starts with. Passkey is the standard; others follow in the order authenticator app, recovery code.",
    type: "select",
    default: "passkey",
    options: [
      { value: "passkey", label: "Passkey" },
      { value: "totp", label: "Authenticator app" },
    ],
  },
  {
    key: "time_zone",
    group: "general",
    label: "Portal time zone",
    description: "Used for calendar months (streak restores) and the times in alert emails.",
    type: "timezone",
    default: "America/New_York",
  },
];

export type SettingValue = number | boolean | string;

export function settingDef(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key);
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parses an incoming value for a setting. Returns an error sentence or the clean value. */
export function coerceSetting(def: SettingDef, raw: unknown): { ok: true; value: SettingValue } | { ok: false; error: string } {
  switch (def.type) {
    case "int": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isInteger(n)) return { ok: false, error: `${def.label} must be a whole number.` };
      if (def.min !== undefined && n < def.min) return { ok: false, error: `${def.label} must be at least ${def.min}.` };
      if (def.max !== undefined && n > def.max) return { ok: false, error: `${def.label} must be at most ${def.max}.` };
      return { ok: true, value: n };
    }
    case "bool":
      if (raw === true || raw === "true" || raw === 1 || raw === "1") return { ok: true, value: true };
      if (raw === false || raw === "false" || raw === 0 || raw === "0") return { ok: true, value: false };
      return { ok: false, error: `${def.label} must be on or off.` };
    case "select": {
      const v = String(raw);
      if (!def.options?.some((o) => o.value === v)) {
        return { ok: false, error: `${def.label} must be one of: ${def.options?.map((o) => o.label).join(", ")}.` };
      }
      return { ok: true, value: v };
    }
    case "timezone": {
      const v = String(raw);
      if (!validTimeZone(v)) return { ok: false, error: `"${v}" is not a time zone this server knows.` };
      return { ok: true, value: v };
    }
  }
}

export interface Settings {
  streak_restores: number;
  auto_block_enabled: boolean;
  auto_block_window_minutes: number;
  auto_block_failed_passwords: number;
  auto_block_failed_mfa: number;
  auto_block_accounts: number;
  auto_block_admin_denied: number;
  auto_block_rate_limits: number;
  auto_block_hostile_score: number;
  auto_block_minutes: number;
  allowlist_mode: "off" | "admins" | "everyone";
  mfa_default_method: "passkey" | "totp";
  time_zone: string;
}

/** Stored values (JSON-decoded) merged over the defaults; anything invalid falls back to its default. */
export function resolveSettings(stored: Record<string, unknown>): Settings {
  const out: Record<string, SettingValue> = {};
  for (const def of SETTINGS) {
    const parsed = def.key in stored ? coerceSetting(def, stored[def.key]) : null;
    out[def.key] = parsed?.ok ? parsed.value : def.default;
  }
  return out as unknown as Settings;
}
