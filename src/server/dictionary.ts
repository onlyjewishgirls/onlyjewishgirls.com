import "server-only";
import { sortedWordSet, type WordSet } from "@/lib/password/matcher";
// Folded, deduplicated and sorted ahead of time by `npm run dictionary`
// (scripts/dictionary-source.ts), so the Worker only has to load it.
import words from "./dictionary-words.json";

let dictionary: WordSet | undefined;

export function getDictionary(): WordSet {
  dictionary ??= sortedWordSet(words);
  return dictionary;
}
