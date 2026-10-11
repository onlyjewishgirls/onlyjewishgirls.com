import { describe, expect, it } from "vitest";
import { bucketByDay } from "@/lib/admin/days";
import { describeDevice, timeAgo } from "@/lib/admin/format";
import { ADMIN_ACTIONS, allowedActions, can, canCreate, canRevert, type AdminAction, type Role } from "@/lib/admin/permissions";
import { checkPassword, passwordIsValid } from "@/lib/password/policy";
import { looksLikeLoginName, validateEmail } from "@/lib/validation";
import { getDictionary } from "@/server/dictionary";
import { generateTemporaryPassword } from "@/server/temp-password";

const owner = { id: 1, role: "owner" as Role };
const admin = { id: 2, role: "admin" as Role };
const admin2 = { id: 3, role: "admin" as Role };
const member = { id: 4, role: "member" as Role };
const member2 = { id: 5, role: "member" as Role };

const SELF_LOCKOUT: AdminAction[] = [
  "suspend",
  "unsuspend",
  "set_temp_password",
  "remove_passkey",
  "disable_totp",
  "clear_recovery_codes",
  "reset_two_step",
  "set_role",
  "delete",
];

describe("admin permissions", () => {
  it("members can't do anything", () => {
    for (const target of [owner, admin, member, member2]) expect(allowedActions(member, target)).toEqual([]);
  });

  it("nobody can act on the owner except the owner on their own account", () => {
    for (const actor of [admin, admin2]) expect(allowedActions(actor, owner)).toEqual([]);
    expect(allowedActions(owner, owner)).toEqual(ADMIN_ACTIONS.filter((a) => !SELF_LOCKOUT.includes(a)));
  });

  it("nobody can lock themselves out", () => {
    for (const actor of [owner, admin]) {
      for (const action of SELF_LOCKOUT) expect(can(actor, action, actor)).toBe(false);
      expect(can(actor, "sign_out_everywhere", actor)).toBe(true);
      expect(can(actor, "edit_profile", actor)).toBe(true);
    }
  });

  it("admins manage members, but not other admins, and can't change roles", () => {
    expect(allowedActions(admin, member)).toEqual(ADMIN_ACTIONS.filter((a) => a !== "set_role"));
    expect(allowedActions(admin, admin2)).toEqual([]);
  });

  it("the owner manages admins and members, including roles", () => {
    expect(allowedActions(owner, admin)).toEqual([...ADMIN_ACTIONS]);
    expect(allowedActions(owner, member)).toEqual([...ADMIN_ACTIONS]);
  });

  it("only the owner creates admins, and nobody creates an owner", () => {
    expect(canCreate(owner, "admin")).toBe(true);
    expect(canCreate(owner, "member")).toBe(true);
    expect(canCreate(owner, "owner")).toBe(false);
    expect(canCreate(admin, "member")).toBe(true);
    expect(canCreate(admin, "admin")).toBe(false);
    expect(canCreate(member, "member")).toBe(false);
  });

  it("only the owner undoes changes, and only ones they could make", () => {
    expect(canRevert(owner, "suspend", member)).toBe(true);
    expect(canRevert(owner, "set_role", admin)).toBe(true);
    expect(canRevert(owner, "suspend", owner)).toBe(false);
    expect(canRevert(admin, "suspend", member)).toBe(false);
  });
});

describe("temporary passwords", () => {
  const person = {
    firstName: "Chaya",
    middleName: "Rivka",
    lastName: "Goldberg",
    username: "chaya_g",
    email: "chaya@example.com",
    phone: "+12125550147",
  };

  it("always pass every password rule for the person", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const password = generateTemporaryPassword(person);
      expect(password).toHaveLength(20);
      expect(passwordIsValid(checkPassword(password, person, { dictionary: getDictionary() }))).toBe(true);
      expect(password).not.toMatch(/[0O1lI]/);
      seen.add(password);
    }
    expect(seen.size).toBe(25);
  });
});

describe("admin formatting", () => {
  it("names devices from their user agent", () => {
    expect(
      describeDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"),
    ).toBe("Chrome on Android");
    expect(
      describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toBe("Safari on iPhone");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe(
      "Edge on Windows",
    );
    expect(describeDevice(null)).toBe("Unknown device");
  });

  it("says how long ago things happened", () => {
    const now = Date.UTC(2026, 9, 11, 12);
    expect(timeAgo(now - 30_000, now, "UTC")).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now, "UTC")).toBe("5 min ago");
    expect(timeAgo(now - 3 * 3_600_000, now, "UTC")).toBe("3 hr ago");
    expect(timeAgo(now - 86_400_000, now, "UTC")).toBe("1 day ago");
    expect(timeAgo(now - 30 * 86_400_000, now, "UTC")).toBe("Sep 11, 2026");
    expect(timeAgo(null, now, "UTC")).toBe("Never");
  });
});

describe("daily buckets", () => {
  const tz = "America/New_York";
  const days = (now: number) => bucketByDay([], 30, now, tz).map((d) => d.date);

  it("has 30 distinct calendar days around daylight-saving changes", () => {
    // 23:30 EST, ten days after clocks went back; 00:30 EDT, a week after they went forward.
    for (const now of [Date.UTC(2026, 10, 11, 4, 30), Date.UTC(2026, 2, 15, 4, 30)]) {
      const list = days(now);
      expect(list).toHaveLength(30);
      expect(new Set(list).size).toBe(30);
    }
    expect(days(Date.UTC(2026, 10, 11, 4, 30))).toContain("2026-11-01");
    expect(days(Date.UTC(2026, 2, 15, 4, 30))).toContain("2026-03-08");
    expect(days(Date.UTC(2026, 10, 11, 4, 30)).at(-1)).toBe("2026-11-10");
  });

  it("counts each person once per day, in the viewer's time zone", () => {
    const now = Date.UTC(2026, 9, 11, 16);
    const buckets = bucketByDay(
      [
        { at: Date.UTC(2026, 9, 11, 3), key: 1 }, // Oct 10, 11 PM in New York
        { at: Date.UTC(2026, 9, 11, 15), key: 1 },
        { at: Date.UTC(2026, 9, 11, 15, 30), key: 1 },
        { at: Date.UTC(2026, 9, 11, 15, 45), key: 2 },
      ],
      3,
      now,
      tz,
    );
    expect(buckets).toEqual([
      { date: "2026-10-09", count: 0 },
      { date: "2026-10-10", count: 1 },
      { date: "2026-10-11", count: 2 },
    ]);
  });
});

describe("what the sign-in log may record", () => {
  it("keeps usernames and emails", () => {
    expect(looksLikeLoginName("chaya_test")).toBe(true);
    expect(looksLikeLoginName("Chaya@Example.com")).toBe(true);
  });

  it("never keeps anything that could be a password", () => {
    expect(looksLikeLoginName("Xq7#Rv!Kz9Wm$Pd2")).toBe(false);
    // Uses only _ and . as symbols, so it would also pass as a username.
    expect(looksLikeLoginName("Abcde_FGH.ijk12345")).toBe(false);
    expect(looksLikeLoginName("hunter2 with spaces")).toBe(false);
    expect(looksLikeLoginName("")).toBe(false);
  });
});

describe("email addresses", () => {
  it("accepts ordinary addresses", () => {
    for (const email of ["chaya@example.com", "o'brien+tag@mail.co.uk", "me@xn--bcher-kva.example"]) {
      expect(validateEmail(email)).toBeUndefined();
    }
  });

  it("rejects addresses that could add fields to a mailto: link", () => {
    for (const email of ["me@example.com?bcc=spy%40evil%2ecom", "me@exam_ple.com", "a@b", 'x"y@example.com']) {
      expect(validateEmail(email)).toBe("Enter a valid email address");
    }
  });
});
