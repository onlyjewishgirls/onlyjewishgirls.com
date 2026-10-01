/** Registration field rules shared by the browser form and the API. */

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export interface RegistrationInput {
  firstName: string;
  middleName: string;
  noMiddleName: boolean;
  lastName: string;
  email: string;
  username: string;
  phoneCountry: string;
  phone: string;
  password: string;
  confirmPassword: string;
  timeZone?: string;
}

export type FieldErrors = Partial<Record<keyof RegistrationInput, string>>;

const NAME_PATTERN = /^[\p{L}\p{M}](?:[\p{L}\p{M}' .-]*[\p{L}\p{M}.])?$/u;
const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.]{2,29}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "root",
  "support",
  "help",
  "moderator",
  "mod",
  "staff",
  "system",
  "security",
  "official",
  "onlyjewishgirls",
  "ojg",
]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function validateName(value: string, label: string): string | undefined {
  const name = normalizeName(value);
  if (!name) return `${label} is required`;
  if (name.length > 50) return `${label} must be 50 characters or fewer`;
  if (!NAME_PATTERN.test(name)) return `${label} can only contain letters, spaces, hyphens, apostrophes and periods`;
  return undefined;
}

export function validateUsername(value: string): string | undefined {
  const username = value.trim();
  if (!username) return "Username is required";
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3–30 characters, start with a letter, and use only letters, numbers, _ or .";
  }
  if (/\.\.|\.$/.test(username)) return "Username can't have two periods in a row or end with a period";
  if (RESERVED_USERNAMES.has(username.toLowerCase())) return "That username is reserved";
  return undefined;
}

export function validateEmail(value: string): string | undefined {
  const email = normalizeEmail(value);
  if (!email) return "Email is required";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address";
  return undefined;
}

export function parsePhone(phone: string, country: string) {
  return parsePhoneNumberFromString(phone.trim(), country as CountryCode);
}

export function validatePhone(phone: string, country: string): string | undefined {
  if (!phone.trim()) return "Mobile number is required";
  const parsed = parsePhone(phone, country);
  if (!parsed || !parsed.isValid()) return "Enter a valid mobile number";
  return undefined;
}

/**
 * Everything except the password policy, which has its own live checklist,
 * and uniqueness, which needs the database.
 */
export function validateRegistration(input: RegistrationInput): FieldErrors {
  const errors: FieldErrors = {};
  errors.firstName = validateName(input.firstName, "First name");
  if (input.noMiddleName) {
    if (input.middleName.trim()) errors.middleName = "Clear the middle name or uncheck “No middle name”";
  } else {
    errors.middleName = input.middleName.trim()
      ? validateName(input.middleName, "Middle name")
      : "Middle name is required — or check “No middle name”";
  }
  errors.lastName = validateName(input.lastName, "Last name");
  errors.email = validateEmail(input.email);
  errors.username = validateUsername(input.username);
  errors.phone = validatePhone(input.phone, input.phoneCountry);
  if (!input.password) errors.password = "Password is required";
  if (input.password !== input.confirmPassword) errors.confirmPassword = "Passwords don't match";
  for (const key of Object.keys(errors) as (keyof FieldErrors)[]) {
    if (!errors[key]) delete errors[key];
  }
  return errors;
}
