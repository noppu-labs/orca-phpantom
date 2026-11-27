import { diff3Merge } from './vendor/diff3.mjs';

const lines = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/u));
const terminated = (chunk: string[]): string => {
  const text = chunk.join('');
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
};

const MAX_DIFF_LINES = 500;

const sameLines = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((line, at) => line === right[at]);

/** Positions of the longest strictly increasing run of `values` (patience sorting, O(n log n)). */
function longestIncreasing(values: number[]): number[] {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      // oxlint-disable-next-line eslint/no-bitwise -- halves the sum of two array indexes, which stay far below 2^31
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < values[index]) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    previous[index] = low > 0 ? tails[low - 1] : -1;
    tails[low] = index;
  }
  const run: number[] = [];
  for (let at = tails.at(-1) ?? -1; at !== -1; at = previous[at]) {
    run.push(at);
  }
  return run.reverse();
}

function occurrences(items: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  items.forEach((item, at) => {
    seen.set(item, seen.has(item) ? -1 : at);
  });
  return seen;
}

/**
 * Lines that occur exactly once in all three texts and keep their order: the merge cannot cross
 * them, so each stretch between two of them is merged on its own. The LCS inside diff3 is
 * quadratic in the worst case, and a 1 MB file with a few edits far apart is that case.
 */
function anchors(mine: string[], base: string[], outside: string[]): [number, number, number][] {
  const inMine = occurrences(mine);
  const inOutside = occurrences(outside);
  const found: [number, number, number][] = [];
  occurrences(base).forEach((at, line) => {
    const mineAt = inMine.get(line);
    const outsideAt = inOutside.get(line);
    if (
      at >= 0 &&
      mineAt !== undefined &&
      mineAt >= 0 &&
      outsideAt !== undefined &&
      outsideAt >= 0
    ) {
      found.push([mineAt, at, outsideAt]);
    }
  });
  found.sort((left, right) => left[1] - right[1]);
  const byMine = longestIncreasing(found.map((entry) => entry[0])).map(
    (position) => found[position]
  );
  return longestIncreasing(byMine.map((entry) => entry[2])).map((position) => byMine[position]);
}

/**
 * Three-way line merge. Changes that do not overlap are both kept; an overlap is written out with
 * both sides between conflict markers so nothing is dropped.
 */
function mergeText(
  base: string,
  outside: string,
  mine: string
): { text: string; conflicts: number } {
  if (mine === base || mine === outside) {
    return { conflicts: 0, text: outside };
  }
  if (outside === base) {
    return { conflicts: 0, text: mine };
  }
  const mineLines = lines(mine);
  const baseLines = lines(base);
  const outsideLines = lines(outside);
  let text = '';
  let conflicts = 0;
  const conflict = (mineChunk: string[], outsideChunk: string[]): void => {
    conflicts += 1;
    text += `<<<<<<< your unsaved edits\n${terminated(mineChunk)}=======\n${terminated(outsideChunk)}>>>>>>> file on disk\n`;
  };
  const mergeStretch = (mineChunk: string[], baseChunk: string[], outsideChunk: string[]): void => {
    if (mineChunk.length === 0 && baseChunk.length === 0 && outsideChunk.length === 0) {
      return;
    }
    if (sameLines(mineChunk, baseChunk)) {
      text += outsideChunk.join('');
      return;
    }
    if (sameLines(outsideChunk, baseChunk) || sameLines(mineChunk, outsideChunk)) {
      text += mineChunk.join('');
      return;
    }
    // Why: diff3's LCS grows roughly cubically on repeated lines and runs on the editor's thread, so a stretch with no anchors that is too big to diff within budget keeps both sides whole.
    if (Math.max(mineChunk.length, baseChunk.length, outsideChunk.length) > MAX_DIFF_LINES) {
      conflict(mineChunk, outsideChunk);
      return;
    }
    for (const region of diff3Merge(mineChunk, baseChunk, outsideChunk, {
      excludeFalseConflicts: true,
    })) {
      if (region.ok) {
        text += region.ok.join('');
      } else if (region.conflict) {
        conflict(region.conflict.a, region.conflict.b);
      }
    }
  };
  let [fromMine, fromBase, fromOutside] = [0, 0, 0];
  for (const [mineAt, baseAt, outsideAt] of anchors(mineLines, baseLines, outsideLines)) {
    mergeStretch(
      mineLines.slice(fromMine, mineAt),
      baseLines.slice(fromBase, baseAt),
      outsideLines.slice(fromOutside, outsideAt)
    );
    text += baseLines[baseAt];
    [fromMine, fromBase, fromOutside] = [mineAt + 1, baseAt + 1, outsideAt + 1];
  }
  mergeStretch(
    mineLines.slice(fromMine),
    baseLines.slice(fromBase),
    outsideLines.slice(fromOutside)
  );
  return { conflicts, text };
}

export { mergeText };
