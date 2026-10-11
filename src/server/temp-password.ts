import "server-only";
import { randomInt } from "node:crypto";
import { checkPassword, passwordIsValid, type PersonalInfo } from "@/lib/password/policy";
import { getDictionary } from "./dictionary";

// No look-alikes (0/O, 1/l/I), so it can be read out or typed from a screen.
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!#$%&*+=?@^~";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;
const LENGTH = 20;

const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)];

/**
 * A random temporary password that passes every password rule for this
 * person (no dictionary words, sequences or pieces of their details).
 */
export function generateTemporaryPassword(person: PersonalInfo): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const chars = [pick(UPPER), pick(UPPER), pick(UPPER), pick(LOWER), pick(LOWER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
    while (chars.length < LENGTH) chars.push(pick(ALL));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const password = chars.join("");
    if (passwordIsValid(checkPassword(password, person, { dictionary: getDictionary() }))) return password;
  }
  throw new Error("Couldn't generate a temporary password that passes the rules");
}
