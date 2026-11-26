import type { LspContentChange, LspPosition } from '../../src/protocol.ts'

export const REQUEST_BUDGET_BYTES = 56 * 1024

const encoder = new TextEncoder()

export function encodedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

/** UTF-8 bytes one UTF-16 unit (or a surrogate pair, when `next` completes it) adds to a JSON string. */
function jsonCost(unit: number, pairedWith: number | null): number {
  if (unit === 0x22 || unit === 0x5c) return 2
  if (unit < 0x20) return unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6
  if (unit < 0x80) return 1
  if (unit < 0x800) return 2
  if (unit >= 0xd800 && unit <= 0xdfff) return pairedWith !== null ? 4 : 6
  return 3
}

export function chunkText(text: string, budget: number = REQUEST_BUDGET_BYTES): string[] {
  if (text === '') return ['']
  const pieces: string[] = []
  let start = 0
  let size = 2
  let i = 0
  while (i < text.length) {
    const unit = text.charCodeAt(i)
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
    const paired = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    const width = paired ? 2 : 1
    const cost = jsonCost(unit, paired ? next : null)
    if (size + cost > budget && i > start) {
      // A piece starting with LF would fuse with a lone CR before the insertion point and move that point.
      let cut = i
      const unsafe = (c: number) => {
        const u = text.charCodeAt(c)
        const midPair = u >= 0xdc00 && u <= 0xdfff && (text.charCodeAt(c - 1) & 0xfc00) === 0xd800
        return u === 0x0a || midPair
      }
      while (cut > start + 1 && unsafe(cut)) cut -= 1
      if (unsafe(cut)) cut = i
      pieces.push(text.slice(start, cut))
      start = cut
      i = cut
      size = 2
      continue
    }
    size += cost
    i += width
  }
  pieces.push(text.slice(start))
  return pieces
}

const MAX = 4294967295
const ENVELOPE = encodedSize({
  range: { start: { line: MAX, character: MAX }, end: { line: MAX, character: MAX } },
  text: '',
})

/**
 * The last piece replaces the range and the earlier ones are inserted, last to first, at the range start, so no
 * position is derived from inserted text. Precondition: the character before the range start is not a lone CR
 * (Monaco normalises its buffers to a single EOL); chunkText also keeps LF off the start of every later piece.
 */
function splitOne(change: LspContentChange, budget: number): LspContentChange[] {
  const textBudget = budget - 2 - ENVELOPE + 2
  const pieces = chunkText(change.text, Math.max(textBudget, 16))
  const last = pieces[pieces.length - 1]
  const at = 'range' in change ? change.range.start : { line: 0, character: 0 }
  const out: LspContentChange[] = ['range' in change ? { range: change.range, text: last } : { text: last }]
  for (let i = pieces.length - 2; i >= 0; i--) out.push({ range: { start: at, end: at }, text: pieces[i] })
  return out
}

export function splitChanges(changes: LspContentChange[], budget: number = REQUEST_BUDGET_BYTES): LspContentChange[][] {
  const groups: LspContentChange[][] = []
  let current: LspContentChange[] = []
  let size = 2
  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
    size = 2
  }
  for (const change of changes) {
    const own = encodedSize(change)
    if (own + 2 > budget) {
      flush()
      for (const piece of splitOne(change, budget)) groups.push([piece])
      continue
    }
    const added = own + (current.length > 0 ? 1 : 0)
    if (size + added > budget) flush()
    size += own + (current.length > 0 ? 1 : 0)
    current.push(change)
  }
  flush()
  return groups
}
