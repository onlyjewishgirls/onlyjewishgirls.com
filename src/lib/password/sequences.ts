/**
 * Detects predictable sequences in a password. Case-insensitive.
 *
 *  - alphabet / number runs:   abc, CBA, 123, 987
 *  - keyboard rows:            qwe, asd, zxc, 890, !@#, op[
 *  - keyboard columns:         1qa, qaz, 2ws, wsx (and reversed)
 *  - number-pad lines:         147, 258, 369, 159, 357 (and reversed)
 *  - repeated characters:      aaa, 111
 *  - repeated chunks:          abab, 1212, xyzxyz
 *  - skip-counting runs:       2468, 1357, aceg (step of 2, four or more)
 */

const RUN_LENGTH = 3;

const KEYBOARD_LINES = [
  "`1234567890-=",
  "~!@#$%^&*()_+",
  "qwertyuiop[]\\",
  "asdfghjkl;'",
  "zxcvbnm,./",
  // columns
  "1qaz",
  "2wsx",
  "3edc",
  "4rfv",
  "5tgb",
  "6yhn",
  "7ujm",
  "8ik,",
  "9ol.",
  "0p;/",
  // number pad
  "789",
  "456",
  "123",
  "147",
  "258",
  "369",
  "159",
  "357",
];

const KEYBOARD_TRIGRAMS: Set<string> = (() => {
  const set = new Set<string>();
  for (const line of KEYBOARD_LINES) {
    for (const l of [line, [...line].reverse().join("")]) {
      for (let i = 0; i + RUN_LENGTH <= l.length; i++) set.add(l.slice(i, i + RUN_LENGTH));
    }
  }
  return set;
})();

type CharClass = "letter" | "digit" | null;

function classOf(ch: string): CharClass {
  if (ch >= "a" && ch <= "z") return "letter";
  if (ch >= "0" && ch <= "9") return "digit";
  return null;
}

/** Finds a run where each char is `step` (or `-step`) away from the previous one. */
function findStepRun(
  chars: string[],
  step: number,
  minLength: number,
): { start: number; length: number } | null {
  for (let i = 0; i + minLength <= chars.length; i++) {
    const cls = classOf(chars[i]);
    if (!cls) continue;
    for (const dir of [step, -step]) {
      let len = 1;
      while (
        i + len < chars.length &&
        classOf(chars[i + len]) === cls &&
        chars[i + len].charCodeAt(0) - chars[i + len - 1].charCodeAt(0) === dir
      ) {
        len++;
      }
      if (len >= minLength) return { start: i, length: len };
    }
  }
  return null;
}

export interface SequenceMatch {
  kind: "alphabet" | "keyboard" | "repeat" | "pattern" | "skip";
  found: string;
}

export function findSequence(password: string): SequenceMatch | null {
  const original = Array.from(password);
  const chars = original.map((c) => c.toLowerCase());
  const show = (start: number, len: number) => original.slice(start, start + len).join("");

  const run = findStepRun(chars, 1, RUN_LENGTH);
  if (run) return { kind: "alphabet", found: show(run.start, run.length) };

  for (let i = 0; i + RUN_LENGTH <= chars.length; i++) {
    if (KEYBOARD_TRIGRAMS.has(chars.slice(i, i + RUN_LENGTH).join(""))) {
      return { kind: "keyboard", found: show(i, RUN_LENGTH) };
    }
  }

  for (let i = 0; i + RUN_LENGTH <= chars.length; i++) {
    if (chars[i] === chars[i + 1] && chars[i] === chars[i + 2]) {
      return { kind: "repeat", found: show(i, RUN_LENGTH) };
    }
  }

  for (let size = 2; size * 2 <= chars.length; size++) {
    for (let i = 0; i + size * 2 <= chars.length; i++) {
      const a = chars.slice(i, i + size).join("");
      const b = chars.slice(i + size, i + size * 2).join("");
      if (a === b) return { kind: "pattern", found: show(i, size * 2) };
    }
  }

  const skip = findStepRun(chars, 2, 4);
  if (skip) return { kind: "skip", found: show(skip.start, skip.length) };

  return null;
}
