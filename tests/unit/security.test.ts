import { describe, expect, it } from "vitest";
import { MFA_ORDER, defaultMfaMethod, sortMfa } from "@/lib/mfa-order";
import {
  alertRouting,
  apexDomain,
  findInjection,
  formatDuration,
  ipInRange,
  isDecoyPath,
  rangeProblem,
  threatBand,
  threatScore,
} from "@/lib/security";
import { coerceSetting, resolveSettings, settingDef } from "@/lib/settings-schema";
import { crossedThreshold } from "@/server/threat";

describe("alert routing (§6)", () => {
  it("derives the registrable domain", () => {
    expect(apexDomain("wamv.chaimyuirmafia.com")).toBe("chaimyuirmafia.com");
    expect(apexDomain("www.onlyjewishgirls.com:443")).toBe("onlyjewishgirls.com");
    expect(apexDomain("onlyjewishgirls.com.")).toBe("onlyjewishgirls.com");
    expect(apexDomain("portal.example.co.uk")).toBe("example.co.uk");
    expect(apexDomain("a.b.example.co.il")).toBe("example.co.il");
  });

  it("new names win, then the old names, then securityalerts@ / soc@ the apex", () => {
    expect(alertRouting({}, "www.onlyjewishgirls.com")).toEqual({
      from: "securityalerts@onlyjewishgirls.com",
      to: "soc@onlyjewishgirls.com",
      from_source: "default",
      to_source: "default",
    });
    expect(alertRouting({ ALERT_EMAIL_FROM: "old@x.com", ALERT_EMAIL_TO: "oldsoc@x.com" }, "a.com")).toMatchObject({
      from: "old@x.com",
      to: "oldsoc@x.com",
      from_source: "legacy_env",
    });
    expect(
      alertRouting({ ALERTS_EMAIL_FROM: "new@x.com", ALERTS_EMAIL_TO: "soc@x.com", ALERT_EMAIL_FROM: "old@x.com" }, "a.com"),
    ).toMatchObject({ from: "new@x.com", to: "soc@x.com", from_source: "env", to_source: "env" });
    expect(alertRouting({ ALERTS_EMAIL_FROM: "  " }, "a.com").from).toBe("securityalerts@a.com");
  });
});

describe("IP ranges", () => {
  it("matches IPv4 and IPv6 addresses and CIDRs", () => {
    expect(ipInRange("203.0.113.7", "203.0.113.0/24")).toBe(true);
    expect(ipInRange("203.0.114.7", "203.0.113.0/24")).toBe(false);
    expect(ipInRange("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(ipInRange("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInRange("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInRange("203.0.113.7", "2001:db8::/32")).toBe(false);
  });
  it("refuses malformed and overly wide ranges", () => {
    expect(rangeProblem("0.0.0.0/0")).toMatch(/whole internet/);
    expect(rangeProblem("10.0.0.0/4")).toMatch(/wider than \/8/);
    expect(rangeProblem("300.1.1.1")).toMatch(/not an IP address/);
    expect(rangeProblem("10.0.0.0/8")).toBeNull();
  });
});

describe("suspicious activity (§7)", () => {
  it("recognises scanner paths", () => {
    for (const p of ["/.env", "/.env.local", "/.git/config", "/wp-admin/", "/wp-login.php", "/phpmyadmin/index.php", "/xmlrpc.php", "/shell.php"]) {
      expect(isDecoyPath(p)).toBe(true);
    }
    for (const p of ["/login", "/home", "/admin", "/api/auth/login", "/environment"]) expect(isDecoyPath(p)).toBe(false);
  });

  it("recognises injection and traversal signatures", () => {
    expect(findInjection(["../../etc/passwd"])?.name).toBe("path traversal");
    expect(findInjection(["%2e%2e%2fetc"])?.name).toBe("path traversal");
    expect(findInjection(["<script>alert(1)</script>"])?.name).toBe("script tag");
    expect(findInjection(["' OR 1=1"])?.name).toBe("SQL tautology");
    expect(findInjection(["1 UNION SELECT password FROM users"])?.name).toBe("SQL UNION");
    expect(findInjection(["miriam", "miriam@example.com", "O'Brien"])).toBeNull();
  });

  const defaults = resolveSettings({});
  it("has the standard's default thresholds", () => {
    expect(defaults).toMatchObject({
      auto_block_enabled: true,
      auto_block_window_minutes: 15,
      auto_block_failed_passwords: 5,
      auto_block_failed_mfa: 5,
      auto_block_accounts: 3,
      auto_block_admin_denied: 3,
      auto_block_rate_limits: 3,
      auto_block_minutes: 0,
      streak_restores: 3,
      mfa_default_method: "passkey",
      time_zone: "America/New_York",
    });
  });

  const zero = { failed_password: 0, failed_mfa: 0, accounts: 0, admin_denied: 0, rate_limit: 0, decoy: 0, injection: 0 };
  it("crosses each threshold at the default count, not before", () => {
    const cases: [Partial<typeof zero>, Partial<typeof zero>, string][] = [
      [{ failed_password: 4 }, { failed_password: 5 }, "failed_logins"],
      [{ failed_mfa: 4 }, { failed_mfa: 5 }, "failed_mfa"],
      [{ accounts: 2, failed_password: 2 }, { accounts: 3, failed_password: 3 }, "multi_account"],
      [{ admin_denied: 2 }, { admin_denied: 3 }, "admin_denied"],
      [{ rate_limit: 2 }, { rate_limit: 3 }, "rate_limit"],
      [{}, { decoy: 1 }, "decoy"],
      [{}, { injection: 1 }, "injection"],
    ];
    for (const [below, at, trigger] of cases) {
      expect(crossedThreshold({ ...zero, ...below }, defaults)).toBeNull();
      expect(crossedThreshold({ ...zero, ...at }, defaults)?.trigger).toBe(trigger);
    }
  });

  it("scores threats into bands", () => {
    expect(threatBand(0)).toBe("quiet");
    expect(threatBand(20)).toBe("watch");
    expect(threatBand(50)).toBe("suspicious");
    expect(threatBand(80)).toBe("hostile");
    expect(threatScore({ decoy: 1 }).score).toBe(80);
    expect(threatScore({ failed_password: 2, admin_denied: 1 })).toEqual({
      score: 40,
      reasons: ["2 wrong passwords", "1 refused admin request"],
    });
  });

  it("states durations the way the rate-limit message does", () => {
    expect(formatDuration(252)).toBe("4 min 12 s");
    expect(formatDuration(35)).toBe("35 s");
    expect(formatDuration(3900)).toBe("1 h 5 min");
  });
});

describe("settings", () => {
  it("validates with exact messages", () => {
    expect(coerceSetting(settingDef("streak_restores")!, 40)).toEqual({ ok: false, error: "Courtesy restores per month must be at most 31." });
    expect(coerceSetting(settingDef("streak_restores")!, "2")).toEqual({ ok: true, value: 2 });
    expect(coerceSetting(settingDef("time_zone")!, "Mars/Base")).toMatchObject({ ok: false });
    expect(resolveSettings({ streak_restores: 999 }).streak_restores).toBe(3);
  });
});

describe("MFA order (§3)", () => {
  it("is passkey, authenticator app, email (then recovery codes)", () => {
    expect(MFA_ORDER).toEqual(["passkey", "totp", "email", "recovery"]);
    expect(sortMfa(["recovery", "email", "totp", "passkey"])).toEqual(["passkey", "totp", "email", "recovery"]);
  });
  it("defaults to passkey, else the next enrolled method", () => {
    expect(defaultMfaMethod({ passkey: true, totp: true })).toBe("passkey");
    expect(defaultMfaMethod({ passkey: false, totp: true, recovery: true })).toBe("totp");
    expect(defaultMfaMethod({ recovery: true })).toBe("recovery");
    // A user/site preference is kept when enrolled.
    expect(defaultMfaMethod({ passkey: true, totp: true }, "totp")).toBe("totp");
  });
});
