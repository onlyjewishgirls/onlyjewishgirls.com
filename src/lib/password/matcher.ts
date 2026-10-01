/**
 * Finds "forbidden" words hidden inside a password, including look-alike
 * substitutions (P@ssw0rd -> password, Ch@1m -> chaim).
 *
 * Shared by the dictionary rule (server only, the word list is large) and the
 * personal-info rule (runs in the browser too).
 */

/** Characters people commonly swap in for letters. Each char also matches itself. */
const LOOK_ALIKES: Record<string, string[]> = {
  "0": ["o"],
  "1": ["i", "l"],
  "3": ["e"],
  "4": ["a"],
  "5": ["s"],
  "7": ["t"],
  "8": ["b"],
  "9": ["g"],
  "@": ["a"],
  $: ["s"],
  "!": ["i", "l"],
  "|": ["l", "i"],
  "+": ["t"],
  "(": ["c"],
};

/** Lowercase and strip accents so "Chaïm" and "chaim" compare equal. */
export function foldText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

export interface WordSet {
  has(word: string): boolean;
  hasPrefix(prefix: string): boolean;
  maxLength: number;
}

/** Smallest index whose word is >= value. */
function lowerBound(sorted: string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A sorted array with binary search, rather than a Set of every prefix:
 * the dictionary has ~79k words and has to fit in a Worker's memory.
 */
export function createWordSet(words: Iterable<string>, minLength: number): WordSet {
  const unique = new Set<string>();
  for (const raw of words) {
    const word = foldText(raw);
    if (word.length >= minLength) unique.add(word);
  }
  return sortedWordSet([...unique].sort());
}

/** For a list that is already folded, deduplicated and sorted. */
export function sortedWordSet(sorted: string[]): WordSet {
  let maxLength = 0;
  for (const word of sorted) if (word.length > maxLength) maxLength = word.length;
  return {
    has: (w) => sorted[lowerBound(sorted, w)] === w,
    hasPrefix: (p) => {
      // Words starting with p sit right after p itself in sorted order.
      let i = lowerBound(sorted, p);
      if (sorted[i] === p) i++;
      return i < sorted.length && sorted[i].startsWith(p);
    },
    maxLength,
  };
}

export interface WordMatch {
  /** The slice of the password that matched, as typed. */
  found: string;
  /** The forbidden word it matched. */
  word: string;
}

/** Returns the longest forbidden word found in the password, or null. */
export function findForbiddenWord(password: string, words: WordSet): WordMatch | null {
  const chars = Array.from(foldText(password));
  const original = Array.from(password.normalize("NFKC"));
  // foldText can change length for exotic characters; fall back to folded text for display.
  const display = original.length === chars.length ? original : chars;
  let best: WordMatch | null = null;

  for (let start = 0; start < chars.length; start++) {
    // Depth-first over look-alike choices, pruned by the prefix set.
    const stack: Array<{ end: number; text: string }> = [{ end: start, text: "" }];
    while (stack.length > 0) {
      const { end, text } = stack.pop()!;
      if (end >= chars.length || text.length >= words.maxLength) continue;
      const ch = chars[end];
      for (const option of [ch, ...(LOOK_ALIKES[ch] ?? [])]) {
        const next = text + option;
        if (words.has(next) && (!best || next.length > best.word.length)) {
          best = { found: display.slice(start, end + 1).join(""), word: next };
        }
        if (words.hasPrefix(next)) stack.push({ end: end + 1, text: next });
      }
    }
  }
  return best;
}
