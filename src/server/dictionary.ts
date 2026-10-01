import "server-only";
import { createWordSet, type WordSet } from "@/lib/password/matcher";
import { DICTIONARY_MIN_WORD_LENGTH } from "@/lib/password/policy";
import { EXTRA_WORDS } from "./extra-words";
// SCOWL English word lists (US/UK/CA/AU spellings) up to size 60: about 79,000
// words of 4+ letters. Size 70+ adds obscure words that make random strings fail
// too often. Imported file by file because the package's index reads them from disk.
import english10 from "wordlist-english/english-words-10.json";
import english20 from "wordlist-english/english-words-20.json";
import english35 from "wordlist-english/english-words-35.json";
import english40 from "wordlist-english/english-words-40.json";
import english50 from "wordlist-english/english-words-50.json";
import english55 from "wordlist-english/english-words-55.json";
import english60 from "wordlist-english/english-words-60.json";
import american10 from "wordlist-english/american-words-10.json";
import american20 from "wordlist-english/american-words-20.json";
import american35 from "wordlist-english/american-words-35.json";
import american40 from "wordlist-english/american-words-40.json";
import american50 from "wordlist-english/american-words-50.json";
import american55 from "wordlist-english/american-words-55.json";
import american60 from "wordlist-english/american-words-60.json";
import british10 from "wordlist-english/british-words-10.json";
import british20 from "wordlist-english/british-words-20.json";
import british35 from "wordlist-english/british-words-35.json";
import british40 from "wordlist-english/british-words-40.json";
import british50 from "wordlist-english/british-words-50.json";
import british55 from "wordlist-english/british-words-55.json";
import british60 from "wordlist-english/british-words-60.json";
import canadian10 from "wordlist-english/canadian-words-10.json";
import canadian20 from "wordlist-english/canadian-words-20.json";
import canadian35 from "wordlist-english/canadian-words-35.json";
import canadian40 from "wordlist-english/canadian-words-40.json";
import canadian50 from "wordlist-english/canadian-words-50.json";
import canadian55 from "wordlist-english/canadian-words-55.json";
import canadian60 from "wordlist-english/canadian-words-60.json";
import australian10 from "wordlist-english/australian-words-10.json";
import australian20 from "wordlist-english/australian-words-20.json";
import australian35 from "wordlist-english/australian-words-35.json";
import australian40 from "wordlist-english/australian-words-40.json";
import australian50 from "wordlist-english/australian-words-50.json";
import australian55 from "wordlist-english/australian-words-55.json";
import australian60 from "wordlist-english/australian-words-60.json";

const LISTS: string[][] = [
  english10,
  english20,
  english35,
  english40,
  english50,
  english55,
  english60,
  american10,
  american20,
  american35,
  american40,
  american50,
  american55,
  american60,
  british10,
  british20,
  british35,
  british40,
  british50,
  british55,
  british60,
  canadian10,
  canadian20,
  canadian35,
  canadian40,
  canadian50,
  canadian55,
  canadian60,
  australian10,
  australian20,
  australian35,
  australian40,
  australian50,
  australian55,
  australian60,
];

let dictionary: WordSet | undefined;

export function getDictionary(): WordSet {
  dictionary ??= createWordSet(
    [...EXTRA_WORDS, ...LISTS.flat().filter((word) => /^[a-zA-Z]+$/.test(word))],
    DICTIONARY_MIN_WORD_LENGTH,
  );
  return dictionary;
}
