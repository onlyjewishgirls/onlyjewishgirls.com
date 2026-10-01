import { createWordSet, findForbiddenWord, foldText, type WordSet } from "./matcher";
import { findSequence } from "./sequences";

export const PASSWORD_MIN_LENGTH = 16;
export const PASSWORD_MAX_LENGTH = 128;
export const MIN_UPPERCASE = 3;
export const MIN_LOWERCASE = 3;
export const MIN_SYMBOLS = 1;
export const MIN_NUMBERS = 1;
/** Shortest dictionary word we reject. 3-letter words would make almost any password fail. */
export const DICTIONARY_MIN_WORD_LENGTH = 4;
/** Any 3+ character piece of a name, username or email counts as "part of" it. */
export const PERSONAL_FRAGMENT_LENGTH = 3;
/** Any 4+ digit piece of the phone number. */
export const PHONE_FRAGMENT_LENGTH = 4;

export type PasswordRuleId =
  | "length"
  | "uppercase"
  | "lowercase"
  | "symbol"
  | "number"
  | "dictionary"
  | "personal"
  | "sequence";

export const PASSWORD_RULES: ReadonlyArray<{ id: PasswordRuleId; label: string }> = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters` },
  { id: "uppercase", label: `At least ${MIN_UPPERCASE} capital letters` },
  { id: "lowercase", label: `At least ${MIN_LOWERCASE} lowercase letters` },
  { id: "symbol", label: "At least 1 symbol" },
  { id: "number", label: "At least 1 number" },
  { id: "dictionary", label: "No dictionary words, including look-alikes like P@ssw0rd" },
  { id: "personal", label: "No part of your name, username, email or phone number" },
  { id: "sequence", label: "No sequences like abc, 321, qwe, aaa, abab or 2468" },
];

export interface PersonalInfo {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  username?: string;
  email?: string;
  phone?: string;
}

export interface PasswordRuleResult {
  id: PasswordRuleId;
  /** null means the rule was not evaluated (the dictionary check only runs on the server). */
  ok: boolean | null;
  detail?: string;
}

/** Applied before validating and before hashing so the same password always compares equal. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

function ngrams(value: string, size: number): string[] {
  const chars = Array.from(value);
  if (chars.length < size) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= chars.length; i++) out.push(chars.slice(i, i + size).join(""));
  return out;
}

export function personalFragments(info: PersonalInfo): string[] {
  const fragments = new Set<string>();
  const addText = (value: string | undefined, allowTwoLetterTokens: boolean) => {
    if (!value) return;
    const folded = foldText(value);
    // Whole value with separators removed ("bat-sheva" -> "batsheva") plus each token.
    const tokens = [folded.replace(/[^\p{L}\p{N}]+/gu, ""), ...folded.split(/[^\p{L}\p{N}]+/u)];
    for (const token of tokens) {
      const length = Array.from(token).length;
      if (length >= PERSONAL_FRAGMENT_LENGTH) {
        for (const g of ngrams(token, PERSONAL_FRAGMENT_LENGTH)) fragments.add(g);
      } else if (allowTwoLetterTokens && length === 2) {
        fragments.add(token);
      }
    }
  };

  addText(info.firstName, true);
  addText(info.middleName, true);
  addText(info.lastName, true);
  addText(info.username, false);
  if (info.email) {
    const [local, domain = ""] = info.email.split("@");
    addText(local, false);
    for (const label of domain.split(".")) addText(label, false);
  }
  if (info.phone) {
    const digits = info.phone.replace(/\D/g, "");
    for (const g of ngrams(digits, PHONE_FRAGMENT_LENGTH)) fragments.add(g);
  }
  return [...fragments];
}

function count(password: string, pattern: RegExp): number {
  return password.match(pattern)?.length ?? 0;
}

export function checkPassword(
  rawPassword: string,
  info: PersonalInfo,
  options: { dictionary?: WordSet } = {},
): PasswordRuleResult[] {
  const password = normalizePassword(rawPassword);
  const length = Array.from(password).length;
  const upper = count(password, /\p{Lu}/gu);
  const lower = count(password, /\p{Ll}/gu);
  const symbols = count(password, /[\p{P}\p{S}]/gu);
  const numbers = count(password, /\p{Nd}/gu);

  const results: PasswordRuleResult[] = [];

  results.push(
    length > PASSWORD_MAX_LENGTH
      ? { id: "length", ok: false, detail: `Must be ${PASSWORD_MAX_LENGTH} characters or fewer` }
      : { id: "length", ok: length >= PASSWORD_MIN_LENGTH, detail: `${length}/${PASSWORD_MIN_LENGTH}` },
  );
  results.push({ id: "uppercase", ok: upper >= MIN_UPPERCASE, detail: `${upper}/${MIN_UPPERCASE}` });
  results.push({ id: "lowercase", ok: lower >= MIN_LOWERCASE, detail: `${lower}/${MIN_LOWERCASE}` });
  results.push({ id: "symbol", ok: symbols >= MIN_SYMBOLS });
  results.push({ id: "number", ok: numbers >= MIN_NUMBERS });

  if (options.dictionary) {
    const match = password ? findForbiddenWord(password, options.dictionary) : null;
    results.push(
      match
        ? {
            id: "dictionary",
            ok: false,
            detail:
              match.found.toLowerCase() === match.word
                ? `Contains the word “${match.found}”`
                : `“${match.found}” reads as the word “${match.word}”`,
          }
        : { id: "dictionary", ok: password.length > 0 },
    );
  } else {
    results.push({ id: "dictionary", ok: null });
  }

  const personal = createWordSet(personalFragments(info), 2);
  const personalMatch = password ? findForbiddenWord(password, personal) : null;
  results.push(
    personalMatch
      ? { id: "personal", ok: false, detail: `“${personalMatch.found}” matches your personal info` }
      : { id: "personal", ok: password.length > 0 },
  );

  const sequence = findSequence(password);
  results.push(
    sequence
      ? { id: "sequence", ok: false, detail: `“${sequence.found}” is a sequence` }
      : { id: "sequence", ok: password.length > 0 },
  );

  return results;
}

export function passwordIsValid(results: PasswordRuleResult[]): boolean {
  return results.every((r) => r.ok === true);
}
