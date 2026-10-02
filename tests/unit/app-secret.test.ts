import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, parseAppSecret } from "@/server/app-secret";

const key = randomBytes(32);
/** Fixed so its base64 always contains "+" and "/" (and its base64url "-" and "_"). */
const symbolKey = Buffer.from(`fb+/fb+/${"A".repeat(35)}=`, "base64");
const hashed = (value: string) => createHash("sha256").update(`onlyjewishgirls app secret v1\0${value}`).digest();

describe("parseAppSecret", () => {
  it("uses a 32-byte key in base64, base64url or hex as is", () => {
    expect(symbolKey).toHaveLength(32);
    expect(symbolKey.toString("base64url")).toMatch(/-.*_|_.*-/);
    for (const k of [key, symbolKey]) {
      expect(parseAppSecret(k.toString("base64"))).toEqual(k);
      expect(parseAppSecret(k.toString("base64").replace(/=$/, ""))).toEqual(k);
      expect(parseAppSecret(k.toString("base64url"))).toEqual(k);
      expect(parseAppSecret(k.toString("hex"))).toEqual(k);
      expect(parseAppSecret(k.toString("hex").toUpperCase())).toEqual(k);
    }
  });

  it("hashes 43 characters that mix the base64 and base64url alphabets", () => {
    const mixed = `+_${symbolKey.toString("base64url").slice(2, 43)}`;
    expect(mixed).toHaveLength(43);
    expect(parseAppSecret(mixed)).toEqual(hashed(mixed));
  });

  it("ignores spaces, line breaks and quotes from copy-pasting", () => {
    expect(parseAppSecret(`  ${key.toString("base64")}\n`)).toEqual(key);
    expect(parseAppSecret(`${key.toString("hex")}\r\n`)).toEqual(key);
    expect(parseAppSecret(`"${key.toString("base64")}"`)).toEqual(key);
    expect(parseAppSecret(`'${key.toString("hex")}'`)).toEqual(key);
  });

  it.each([
    ["a UUID", "3f2c9a1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c"],
    ["a password manager password", "k9#Vq!2mZ@x7Lp$4Rt&8"],
    ["a 64-byte base64 key", randomBytes(64).toString("base64")],
    ["a 16-byte hex key", randomBytes(16).toString("hex")],
    ["a 48-byte hex key", randomBytes(48).toString("hex")],
    ["43 characters that aren't base64", "!".repeat(43)],
  ])("derives a 32-byte key from %s", (_, value) => {
    const derived = parseAppSecret(value);
    expect(derived).toHaveLength(32);
    expect(parseAppSecret(value)).toEqual(derived);
    expect(parseAppSecret(`${value}x`)).not.toEqual(derived);
  });

  it("doesn't let base64's leniency turn a non-key into a key", () => {
    // Buffer's base64 decoder skips characters it doesn't know, so this decodes to exactly `key`.
    const value = `@@@@${key.toString("base64")}`;
    expect(Buffer.from(value, "base64")).toEqual(key);
    expect(parseAppSecret(value)).toEqual(hashed(value));
  });

  it("explains what's wrong when the value is missing or too short", () => {
    for (const value of [undefined, "", "   ", '""']) {
      expect(() => parseAppSecret(value)).toThrow(ConfigError);
      expect(() => parseAppSecret(value)).toThrow(/APP_SECRET isn't set/);
    }
    expect(() => parseAppSecret("hunter2")).toThrow(/APP_SECRET is too short \(7 characters\)/);
    expect(() => parseAppSecret("x".repeat(15))).toThrow(ConfigError);
    expect(parseAppSecret("x".repeat(16))).toHaveLength(32);
  });
});
