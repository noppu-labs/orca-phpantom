import { diff3Merge } from './vendor/diff3.mjs';

const lines = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/));
const terminated = (chunk: string[]): string => {
  const text = chunk.join('');
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
};

const MAX_DIFF_LINES = 500;

const sameLines = (x: string[], y: string[]): boolean =>
  x.length === y.length && x.every((line, at) => line === y[at]);

/** Positions of the longest strictly increasing run of `values` (patience sorting, O(n log n)). */
function longestIncreasing(values: number[]): number[] {
  const tails: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < values[i]) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    previous[i] = low > 0 ? tails[low - 1] : -1;
    tails[low] = i;
  }
  const run: number[] = [];
  for (let at = tails.length > 0 ? tails.at(-1)! : -1; at !== -1; at = previous[at]) {
    run.push(at);
  }
  return run.reverse();
}

function occurrences(items: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  items.forEach((item, at) => seen.set(item, seen.has(item) ? -1 : at));
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
    const m = inMine.get(line);
    const o = inOutside.get(line);
    if (at >= 0 && m !== undefined && m >= 0 && o !== undefined && o >= 0) {
      found.push([m, at, o]);
    }
  });
  found.sort((x, y) => x[1] - y[1]);
  const byMine = longestIncreasing(found.map((entry) => entry[0])).map((i) => found[i]);
  return longestIncreasing(byMine.map((entry) => entry[2])).map((i) => byMine[i]);
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
  const conflict = (m: string[], o: string[]): void => {
    conflicts += 1;
    text += `<<<<<<< your unsaved edits\n${terminated(m)}=======\n${terminated(o)}>>>>>>> file on disk\n`;
  };
  const mergeStretch = (m: string[], b: string[], o: string[]): void => {
    if (m.length === 0 && b.length === 0 && o.length === 0) {
      return;
    }
    if (sameLines(m, b)) {
      text += o.join('');
      return;
    }
    if (sameLines(o, b) || sameLines(m, o)) {
      text += m.join('');
      return;
    }
    // Why: diff3's LCS grows roughly cubically on repeated lines and runs on the editor's thread, so a stretch with no anchors that is too big to diff within budget keeps both sides whole.
    if (Math.max(m.length, b.length, o.length) > MAX_DIFF_LINES) {
      conflict(m, o);
      return;
    }
    for (const region of diff3Merge(m, b, o, { excludeFalseConflicts: true })) {
      if (region.ok) {
        text += region.ok.join('');
      } else if (region.conflict) {
        conflict(region.conflict.a, region.conflict.b);
      }
    }
  };
  let [fromMine, fromBase, fromOutside] = [0, 0, 0];
  for (const [m, b, o] of anchors(mineLines, baseLines, outsideLines)) {
    mergeStretch(
      mineLines.slice(fromMine, m),
      baseLines.slice(fromBase, b),
      outsideLines.slice(fromOutside, o)
    );
    text += baseLines[b];
    [fromMine, fromBase, fromOutside] = [m + 1, b + 1, o + 1];
  }
  mergeStretch(
    mineLines.slice(fromMine),
    baseLines.slice(fromBase),
    outsideLines.slice(fromOutside)
  );
  return { conflicts, text };
}

export { mergeText };
