import type { LspContentChange, LspPosition } from '../../src/protocol.ts';
import { orcaSize } from '../../src/utils/size.ts';

// Orca refuses a panel request ("panel message exceeds the size limit") whose whole message is over 64 KiB or
// 10,000 arrays and objects by its own measure (see src/utils/size.ts), not by its JSON. A group of changes is held to both budgets below, in JSON bytes and in Orca's measure, which leaves room for the message around it:
export const REQUEST_BUDGET_BYTES = 56 * 1024;
export const REQUEST_BUDGET_OBJECTS = 9000;

const encoder = new TextEncoder();

export function encodedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** UTF-8 bytes one UTF-16 unit (or a surrogate pair, when `next` completes it) adds to a JSON string. */
function jsonCost(unit: number, pairedWith: number | null): number {
  if (unit === 0x22 || unit === 0x5c) return 2;
  if (unit < 0x20) {
    return unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6;
  }
  if (unit < 0x80) return 1;
  if (unit < 0x8_00) return 2;
  if (unit >= 0xd8_00 && unit <= 0xdf_ff) return pairedWith === null ? 6 : 4;
  return 3;
}

export function chunkText(text: string, budget: number = REQUEST_BUDGET_BYTES): string[] {
  if (text === '') return [''];
  const pieces: string[] = [];
  let start = 0;
  let size = 2;
  let i = 0;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const paired = unit >= 0xd8_00 && unit <= 0xdb_ff && next >= 0xdc_00 && next <= 0xdf_ff;
    const width = paired ? 2 : 1;
    const cost = jsonCost(unit, paired ? next : null);
    if (size + cost > budget && i > start) {
      // A piece starting with LF would fuse with a lone CR before the insertion point and move that point.
      let cut = i;
      const unsafe = (c: number) => {
        const u = text.charCodeAt(c);
        const midPair =
          u >= 0xdc_00 && u <= 0xdf_ff && (text.charCodeAt(c - 1) & 0xfc_00) === 0xd8_00;
        return u === 0x0a || midPair;
      };
      while (cut > start + 1 && unsafe(cut)) cut -= 1;
      if (unsafe(cut)) cut = i;
      pieces.push(text.slice(start, cut));
      start = cut;
      i = cut;
      size = 2;
      continue;
    }
    size += cost;
    i += width;
  }
  pieces.push(text.slice(start));
  return pieces;
}

const MAX = 4_294_967_295;
const EMPTY_CHANGE = {
  range: { start: { line: MAX, character: MAX }, end: { line: MAX, character: MAX } },
  text: '',
};
const ENVELOPE = encodedSize(EMPTY_CHANGE);
// A one-change group in Orca's measure, without the text: the array, its element, and the change's own fields.
const ORCA_ENVELOPE = orcaSize([EMPTY_CHANGE]).bytes;

/**
 * The last piece replaces the range and the earlier ones are inserted, last to first, at the range start, so no
 * position is derived from inserted text. Precondition: the character before the range start is not a lone CR
 * (Monaco normalises its buffers to a single EOL); chunkText also keeps LF off the start of every later piece.
 */
function splitOne(change: LspContentChange, budget: number): LspContentChange[] {
  // Why the smaller: a piece's raw UTF-8 bytes never exceed its JSON size, so JSON-bounding it bounds Orca's measure of the text too; this adds what Orca counts around it.
  const textBudget = Math.min(budget - 2 - ENVELOPE + 2, budget - ORCA_ENVELOPE + 2);
  const pieces = chunkText(change.text, Math.max(textBudget, 16));
  const last = pieces.at(-1)!;
  const at = 'range' in change ? change.range.start : { line: 0, character: 0 };
  const out: LspContentChange[] = [
    'range' in change ? { range: change.range, text: last } : { text: last },
  ];
  for (let i = pieces.length - 2; i >= 0; i--) {
    out.push({ range: { start: at, end: at }, text: pieces[i] });
  }
  return out;
}

export function splitChanges(
  changes: LspContentChange[],
  budget: number = REQUEST_BUDGET_BYTES,
  maxObjects: number = REQUEST_BUDGET_OBJECTS
): LspContentChange[][] {
  const groups: LspContentChange[][] = [];
  let current: LspContentChange[] = [];
  // A group is an array: 2 JSON bytes of brackets, 8 Orca bytes and one object.
  let size = 2;
  let orcaBytes = 8;
  let objects = 1;
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    size = 2;
    orcaBytes = 8;
    objects = 1;
  };
  for (const change of changes) {
    const own = encodedSize(change);
    const ownOrca = orcaSize(change);
    if (own + 2 > budget || ownOrca.bytes + 12 > budget || ownOrca.objects + 1 > maxObjects) {
      flush();
      for (const piece of splitOne(change, budget)) groups.push([piece]);
      continue;
    }
    const added = own + (current.length > 0 ? 1 : 0);
    if (
      size + added > budget ||
      orcaBytes + 4 + ownOrca.bytes > budget ||
      objects + ownOrca.objects > maxObjects
    ) {
      flush();
    }
    size += own + (current.length > 0 ? 1 : 0);
    orcaBytes += 4 + ownOrca.bytes;
    objects += ownOrca.objects;
    current.push(change);
  }
  flush();
  return groups;
}
