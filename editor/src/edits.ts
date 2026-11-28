// Adapted from actus7/orca-autocomplete editor/src/edits.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Pure text helpers for the editor; no Monaco here so Node can test them.
import { HIGH_SURROGATE_MAX, HIGH_SURROGATE_MIN } from '../../src/constants/characters.ts';

interface Splice {
  start: number;
  end: number;
  text: string;
}

const isHighSurrogate = (code: number): boolean =>
  code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;

/**
 * The smallest single edit that turns `before` into `after`, or null when they are the same.
 * Applying it instead of replacing everything keeps the cursor, the scroll position and the undo
 * stack when the file changes underneath the editor.
 */
function smallestEdit(before: string, after: string): Splice | null {
  if (before === after) {
    return null;
  }
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  // oxlint-disable-next-line unicorn/prefer-code-point -- compares UTF-16 code units, and the surrogate check below fixes up a cut through a pair
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    // oxlint-disable-next-line unicorn/prefer-code-point -- compares UTF-16 code units, and the surrogate check below fixes up a cut through a pair
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  // Why: never cut through a surrogate pair; an emoji is one character to the person.
  // oxlint-disable-next-line unicorn/prefer-code-point -- tests one UTF-16 code unit for a high surrogate, which codePointAt would merge with its pair
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) {
    start -= 1;
  }
  if (
    endAfter < after.length &&
    endAfter > start &&
    // oxlint-disable-next-line unicorn/prefer-code-point -- tests one UTF-16 code unit for a high surrogate, which codePointAt would merge with its pair
    isHighSurrogate(after.charCodeAt(endAfter - 1))
  ) {
    endBefore += 1;
    endAfter += 1;
  }
  return { end: endBefore, start, text: after.slice(start, endAfter) };
}

export { smallestEdit };
export type { Splice };
