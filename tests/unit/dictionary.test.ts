import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildDictionaryWords } from "../../scripts/dictionary-source";
import committed from "@/server/dictionary-words.json";

const FILE = fileURLToPath(new URL("../../src/server/dictionary-words.json", import.meta.url));

it("the committed dictionary matches the word lists (run `npm run dictionary` to update)", () => {
  const words = buildDictionaryWords();
  if (process.env.UPDATE_DICTIONARY) {
    writeFileSync(FILE, `[\n${words.map((w) => JSON.stringify(w)).join(",\n")}\n]\n`);
    return;
  }
  expect(committed.length).toBe(words.length);
  expect(committed).toEqual(words);
});
