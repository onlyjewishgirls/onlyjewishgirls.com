import "server-only";
import { createRequire } from "node:module";
import { createWordSet, type WordSet } from "@/lib/password/matcher";
import { DICTIONARY_MIN_WORD_LENGTH } from "@/lib/password/policy";
import { EXTRA_WORDS } from "./extra-words";

/**
 * SCOWL English word lists (US/UK/CA/AU spellings) up to size 60 — about
 * 79,000 words of 4+ letters. Size 70+ adds obscure words that make random
 * strings fail too often. Tiers in the package are incremental.
 */
const TIERS = ["10", "20", "35", "40", "50", "55", "60"];
const VARIANTS = ["english", "english/american", "english/british", "english/canadian", "english/australian"];

let dictionary: WordSet | undefined;

export function getDictionary(): WordSet {
  if (!dictionary) {
    const require = createRequire(import.meta.url);
    const lists = require("wordlist-english") as Record<string, string[]>;
    const words: string[] = [...EXTRA_WORDS];
    for (const variant of VARIANTS) {
      for (const tier of TIERS) {
        for (const word of lists[`${variant}/${tier}`] ?? []) {
          if (/^[a-zA-Z]+$/.test(word)) words.push(word);
        }
      }
    }
    dictionary = createWordSet(words, DICTIONARY_MIN_WORD_LENGTH);
  }
  return dictionary;
}
