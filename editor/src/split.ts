import {
  CARRIAGE_RETURN,
  HIGH_SURROGATE_MAX,
  HIGH_SURROGATE_MIN,
  LINE_FEED,
  LOW_SURROGATE_MAX,
  LOW_SURROGATE_MIN,
} from '../../src/constants/characters.ts';
import { ORCA_ARRAY_BYTES, ORCA_SLOT_BYTES } from '../../src/constants/orca-measure.ts';
import { BYTES_PER_KIB } from '../../src/constants/units.ts';
import type { LspContentChange, LspPosition } from '../../src/protocol.ts';
import { orcaSize } from '../../src/utils/size.ts';

// Orca refuses a panel request ("panel message exceeds the size limit") whose whole message is over 64 KiB or
// 10,000 arrays and objects by its own measure (see src/utils/size.ts), not by its JSON.
// A group of changes is held to both budgets below, in JSON bytes and in Orca's measure, which leaves room for the message around it: the session token (up to 128 bytes), the action and request names, and the document id, session and length.
const REQUEST_BUDGET_KIB = 56;
const REQUEST_BUDGET_BYTES = REQUEST_BUDGET_KIB * BYTES_PER_KIB;
const REQUEST_BUDGET_OBJECTS = 9000;

// What JSON escapes: a quotation mark, a backslash and the control characters below a space.
const QUOTATION_MARK = 0x22;
const REVERSE_SOLIDUS = 0x5c;
const FIRST_UNESCAPED = 0x20;
// The control characters with a two-character escape (\b, \t, \n, \f, \r); the rest take six (\u0000).
const BACKSPACE = 0x08;
const TAB = 0x09;
const FORM_FEED = 0x0c;
const UNICODE_ESCAPE_BYTES = 6;
// UTF-8: one byte below 0x80, two below 0x800, three for the rest of a unit, four for a surrogate pair.
const ONE_BYTE_BELOW = 0x80;
const TWO_BYTES_BELOW = 0x8_00;
const THREE_BYTES = 3;
const PAIR_BYTES = 4;
// The bits that mark a unit as a high surrogate, which then equal HIGH_SURROGATE_MIN.
const HIGH_SURROGATE_MASK = 0xfc_00;
// The smallest text budget a piece gets, however large the change around it.
const MIN_TEXT_BUDGET = 16;

const encoder = new TextEncoder();

function encodedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** UTF-8 bytes one UTF-16 unit (or a surrogate pair, when `next` completes it) adds to a JSON string. */
function jsonCost(unit: number, pairedWith: number | null): number {
  if (unit === QUOTATION_MARK || unit === REVERSE_SOLIDUS) return 2;
  if (unit < FIRST_UNESCAPED) {
    return unit === BACKSPACE ||
      unit === TAB ||
      unit === LINE_FEED ||
      unit === FORM_FEED ||
      unit === CARRIAGE_RETURN
      ? 2
      : UNICODE_ESCAPE_BYTES;
  }
  if (unit < ONE_BYTE_BELOW) return 1;
  if (unit < TWO_BYTES_BELOW) return 2;
  if (unit >= HIGH_SURROGATE_MIN && unit <= LOW_SURROGATE_MAX) {
    return pairedWith === null ? UNICODE_ESCAPE_BYTES : PAIR_BYTES;
  }
  return THREE_BYTES;
}

function chunkText(text: string, budget: number = REQUEST_BUDGET_BYTES): string[] {
  if (text === '') return [''];
  const pieces: string[] = [];
  let start = 0;
  let size = 2;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
    const paired =
      unit >= HIGH_SURROGATE_MIN &&
      unit <= HIGH_SURROGATE_MAX &&
      next >= LOW_SURROGATE_MIN &&
      next <= LOW_SURROGATE_MAX;
    const width = paired ? 2 : 1;
    const cost = jsonCost(unit, paired ? next : null);
    if (size + cost > budget && index > start) {
      // A piece starting with LF would fuse with a lone CR before the insertion point and move that point.
      let cut = index;
      const unsafe = (position: number): boolean => {
        const code = text.charCodeAt(position);
        const midPair =
          code >= LOW_SURROGATE_MIN &&
          code <= LOW_SURROGATE_MAX &&
          // oxlint-disable-next-line eslint/no-bitwise -- masks a UTF-16 code unit to test for a high surrogate
          (text.charCodeAt(position - 1) & HIGH_SURROGATE_MASK) === HIGH_SURROGATE_MIN;
        return code === LINE_FEED || midPair;
      };
      while (cut > start + 1 && unsafe(cut)) cut -= 1;
      if (unsafe(cut)) cut = index;
      pieces.push(text.slice(start, cut));
      start = cut;
      index = cut;
      size = 2;
      continue;
    }
    size += cost;
    index += width;
  }
  pieces.push(text.slice(start));
  return pieces;
}

const MAX = 4_294_967_295;
const EMPTY_CHANGE = {
  range: { end: { character: MAX, line: MAX }, start: { character: MAX, line: MAX } },
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
  const pieces = chunkText(change.text, Math.max(textBudget, MIN_TEXT_BUDGET));
  // There is always a last piece: chunkText gives at least one.
  const [last] = pieces.slice(-1);
  const at = 'range' in change ? change.range.start : { character: 0, line: 0 };
  const out: LspContentChange[] = [
    'range' in change ? { range: change.range, text: last } : { text: last },
  ];
  for (let index = pieces.length - 2; index >= 0; index--) {
    out.push({ range: { end: at, start: at }, text: pieces[index] });
  }
  return out;
}

function splitChanges(
  changes: LspContentChange[],
  budget: number = REQUEST_BUDGET_BYTES,
  maxObjects: number = REQUEST_BUDGET_OBJECTS
): LspContentChange[][] {
  const groups: LspContentChange[][] = [];
  let current: LspContentChange[] = [];
  // A group is an array: 2 JSON bytes of brackets, 8 Orca bytes and one object.
  let size = 2;
  let orcaBytes = ORCA_ARRAY_BYTES;
  let objects = 1;
  const flush = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
    size = 2;
    orcaBytes = ORCA_ARRAY_BYTES;
    objects = 1;
  };
  for (const change of changes) {
    const own = encodedSize(change);
    const ownOrca = orcaSize(change);
    if (
      own + 2 > budget ||
      ownOrca.bytes + ORCA_ARRAY_BYTES + ORCA_SLOT_BYTES > budget ||
      ownOrca.objects + 1 > maxObjects
    ) {
      flush();
      for (const piece of splitOne(change, budget)) groups.push([piece]);
      continue;
    }
    const added = own + (current.length > 0 ? 1 : 0);
    if (
      size + added > budget ||
      orcaBytes + ORCA_SLOT_BYTES + ownOrca.bytes > budget ||
      objects + ownOrca.objects > maxObjects
    ) {
      flush();
    }
    size += own + (current.length > 0 ? 1 : 0);
    orcaBytes += ORCA_SLOT_BYTES + ownOrca.bytes;
    objects += ownOrca.objects;
    current.push(change);
  }
  flush();
  return groups;
}

export { REQUEST_BUDGET_BYTES, REQUEST_BUDGET_OBJECTS, encodedSize, chunkText, splitChanges };
