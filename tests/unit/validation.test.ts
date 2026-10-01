import { describe, expect, it } from "vitest";
import { validateRegistration, type RegistrationInput } from "@/lib/validation";

const valid: RegistrationInput = {
  firstName: "Chaya",
  middleName: "Rivka",
  noMiddleName: false,
  lastName: "Goldberg",
  email: "chaya@example.com",
  username: "chaya_g",
  phoneCountry: "US",
  phone: "(212) 555-0147",
  password: "Xq7#Rv!Kz9Wm$Pd2",
  confirmPassword: "Xq7#Rv!Kz9Wm$Pd2",
};

describe("registration fields", () => {
  it("accepts a complete form", () => {
    expect(validateRegistration(valid)).toEqual({});
  });

  it("requires a middle name unless “No middle name” is checked", () => {
    expect(validateRegistration({ ...valid, middleName: "" }).middleName).toMatch(/required/);
    expect(validateRegistration({ ...valid, middleName: "", noMiddleName: true })).toEqual({});
    expect(validateRegistration({ ...valid, noMiddleName: true }).middleName).toMatch(/Clear the middle name/);
  });

  it("accepts Hebrew and hyphenated names", () => {
    expect(validateRegistration({ ...valid, firstName: "חיה", lastName: "Ben-David" })).toEqual({});
    expect(validateRegistration({ ...valid, lastName: "O'Brien" })).toEqual({});
    expect(validateRegistration({ ...valid, firstName: "Chaya2" }).firstName).toBeDefined();
  });

  it("checks email, username and mobile number formats", () => {
    expect(validateRegistration({ ...valid, email: "chaya@" }).email).toBeDefined();
    expect(validateRegistration({ ...valid, username: "ab" }).username).toBeDefined();
    expect(validateRegistration({ ...valid, username: "1chaya" }).username).toBeDefined();
    expect(validateRegistration({ ...valid, username: "admin" }).username).toBe("That username is reserved");
    expect(validateRegistration({ ...valid, phone: "123" }).phone).toBeDefined();
    expect(validateRegistration({ ...valid, phoneCountry: "IL", phone: "052-123-4567" })).toEqual({});
  });

  it("requires the passwords to match", () => {
    expect(validateRegistration({ ...valid, confirmPassword: "nope" }).confirmPassword).toBe("Passwords don't match");
  });
});
