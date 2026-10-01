import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/passwords";

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("Xq7#Rv!Kz9Wm$Pd2");
    expect(stored).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    expect(await verifyPassword("Xq7#Rv!Kz9Wm$Pd2", stored)).toBe(true);
    expect(await verifyPassword("Xq7#Rv!Kz9Wm$Pd3", stored)).toBe(false);
    expect(await verifyPassword("Xq7#Rv!Kz9Wm$Pd2", "garbage")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("Xq7#Rv!Kz9Wm$Pd2")).not.toBe(await hashPassword("Xq7#Rv!Kz9Wm$Pd2"));
  });

  it("treats Unicode look-alike encodings of the same password as equal (NFKC)", async () => {
    const stored = await hashPassword("Ｘq7#Rv!Kz9Wm$Pd2"); // full-width X
    expect(await verifyPassword("Xq7#Rv!Kz9Wm$Pd2", stored)).toBe(true);
  });
});
