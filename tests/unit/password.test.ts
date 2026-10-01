import { describe, expect, it } from "vitest";
import { checkPassword, passwordIsValid, type PasswordRuleId, type PersonalInfo } from "@/lib/password/policy";
import { findSequence } from "@/lib/password/sequences";
import { getDictionary } from "@/server/dictionary";

const dictionary = getDictionary();

const person: PersonalInfo = {
  firstName: "Chaya",
  middleName: "Rivka",
  lastName: "Goldberg",
  username: "chayag18",
  email: "chaya.goldberg@example.com",
  phone: "+12125550147",
};

const STRONG = "Xq7#Rv!Kz9Wm$Pd2";

function failing(password: string, info: PersonalInfo = person): PasswordRuleId[] {
  return checkPassword(password, info, { dictionary })
    .filter((r) => r.ok !== true)
    .map((r) => r.id);
}

function detail(password: string, id: PasswordRuleId, info: PersonalInfo = person) {
  return checkPassword(password, info, { dictionary }).find((r) => r.id === id)?.detail;
}

describe("password policy", () => {
  it("accepts a password that meets every rule", () => {
    expect(failing(STRONG)).toEqual([]);
    expect(passwordIsValid(checkPassword(STRONG, person, { dictionary }))).toBe(true);
  });

  it("requires at least 16 characters and at most 128", () => {
    expect(failing("Xq7#Rv!Kz9Wm$Pd")).toEqual(["length"]);
    expect(failing(STRONG + "Tj4%".repeat(30))).toContain("length");
  });

  it("requires 3 capitals, 3 lowercase, a symbol and a number", () => {
    expect(failing("xq7#rv!Kz9wm$Pd2")).toEqual(["uppercase"]);
    expect(failing("XQ7#RV!Kz9WM$Pd2")).toEqual(["lowercase"]);
    expect(failing("Xq7wRvjKz9WmhPd2")).toEqual(["symbol"]);
    expect(failing("Xqf#Rv!KzjWm$Pdh")).toEqual(["number"]);
  });

  it("rejects dictionary words, including look-alike spellings", () => {
    expect(failing("Xq7#Rv!PasswordQ")).toContain("dictionary");
    expect(detail("Xq7#P@ssw0rdKz9W", "dictionary")).toContain("password");
    expect(failing("Zx7#Qv!sHaLoMkPd")).toContain("dictionary"); // Hebrew transliteration
    expect(failing("Q9#Kv!SUNSHINExZ")).toContain("dictionary");
    expect(failing("Xq7#Rv!Kz9Wm$h0us3")).toContain("dictionary"); // h0us3 -> house
  });

  it("rejects any 3+ character piece of the name, username or email", () => {
    expect(detail("Xq7#Ch@1mKz9Wm$Pd", "personal", { ...person, firstName: "Chaim" })).toContain("Ch@");
    expect(failing("Xq7#Rv!Kz9GOLwm$P")).toContain("personal"); // Goldberg
    expect(failing("Xq7#Rv!Kz9RIVwm$P")).toContain("personal"); // Rivka (middle)
    expect(failing("Xq7#Rv!Kz9Wm$G18P")).toContain("personal"); // chayag18
    expect(failing("Xq7#Rv!Kz9Wm$PXAMd")).toContain("personal"); // example.com
  });

  it("rejects runs of 4+ digits from the phone number", () => {
    expect(failing("Xq7#Rv!Kz5550Wm$Pd")).toContain("personal");
  });

  it("treats a 2-letter name as a forbidden piece", () => {
    expect(failing("Xq7#Rv!Kz9Wm$Pd2Li", { ...person, lastName: "Li" })).toContain("personal");
  });

  it("ignores personal info that is absent", () => {
    expect(failing(STRONG, {})).toEqual([]);
  });

  it("leaves the dictionary rule unchecked when no dictionary is supplied (browser)", () => {
    const rule = checkPassword(STRONG, person).find((r) => r.id === "dictionary");
    expect(rule?.ok).toBeNull();
  });
});

describe("sequence detection", () => {
  it.each([
    ["abc", "alphabet"],
    ["CBA", "alphabet"],
    ["xYz", "alphabet"],
    ["123", "alphabet"],
    ["987", "alphabet"],
    ["qwe", "keyboard"],
    ["ewq", "keyboard"],
    ["ASD", "keyboard"],
    ["zxc", "keyboard"],
    ["890", "keyboard"],
    ["!@#", "keyboard"],
    ["1qa", "keyboard"],
    ["wsx", "keyboard"],
    ["147", "keyboard"],
    ["159", "keyboard"],
    ["aaa", "repeat"],
    ["AaA", "repeat"],
    ["$$$", "repeat"],
    ["abab", "pattern"],
    ["1212", "pattern"],
    ["k9#k9#", "pattern"],
    ["2468", "skip"],
    ["aceg", "skip"],
    ["8642", "skip"],
  ])("finds %s", (seq, kind) => {
    const match = findSequence(`Q${seq}Z`);
    expect(match?.kind).toBe(kind);
    expect(match?.found.toLowerCase()).toContain(seq.toLowerCase().slice(0, 3));
  });

  it("does not flag ordinary mixed characters", () => {
    expect(findSequence(STRONG)).toBeNull();
    expect(findSequence("a1b2c3")).toBeNull();
    expect(findSequence("246")).toBeNull(); // skip-counting needs four
  });

  it("reports the sequence as typed", () => {
    expect(failing("Xq7#Rv!KzQWEm$Pd2")).toEqual(["sequence"]);
    expect(detail("Xq7#Rv!KzQWEm$Pd2", "sequence")).toContain("QWE");
  });
});
