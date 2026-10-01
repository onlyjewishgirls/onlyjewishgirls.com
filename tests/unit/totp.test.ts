import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, totpStep, totpUri, verifyTotp } from "@/server/totp";

const RFC_SECRET = Buffer.from("12345678901234567890");
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (RFC 6238 test vectors, SHA-1)", () => {
  it("encodes and decodes base32", () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_B32);
    expect(base32Decode(RFC_SECRET_B32).equals(RFC_SECRET)).toBe(true);
    expect(base32Decode("gezd gnbv").equals(base32Decode("GEZDGNBV"))).toBe(true);
  });

  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("t=%i -> %s", (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(code.slice(2));
  });

  it("verifies the current code and one step either side", () => {
    const now = 1234567890_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET_B32, "005924", now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, "12345", now, null)).toBeNull();
  });

  it("refuses to accept the same code twice", () => {
    const now = 1234567890_000;
    const step = verifyTotp(RFC_SECRET_B32, "005924", now, null);
    expect(verifyTotp(RFC_SECRET_B32, "005924", now, step)).toBeNull();
  });

  it("builds an otpauth:// URI for authenticator apps", () => {
    const uri = totpUri(RFC_SECRET_B32, "chaya", "OnlyJewishGirls");
    expect(uri).toBe(
      "otpauth://totp/OnlyJewishGirls%3Achaya?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=OnlyJewishGirls&algorithm=SHA1&digits=6&period=30",
    );
  });
});
