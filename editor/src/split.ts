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
      // A piece ending in CR would fuse with a LF that follows it in the document, moving the next insertion point.
      let cut = i
      if (text.charCodeAt(cut - 1) === 0x0d && cut - 1 > start) cut -= 1
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

function endPosition(start: LspPosition, inserted: string): LspPosition {
  let line = start.line
  let lastBreakEnd = -1
  for (let i = 0; i < inserted.length; i++) {
    const c = inserted.charCodeAt(i)
    if (c === 0x0d && inserted.charCodeAt(i + 1) === 0x0a) i++
    else if (c !== 0x0d && c !== 0x0a) continue
    line++
    lastBreakEnd = i + 1
  }
  if (lastBreakEnd < 0) return { line, character: start.character + inserted.length }
  return { line, character: inserted.length - lastBreakEnd }
}

const MAX = 4294967295
const ENVELOPE = encodedSize({
  range: { start: { line: MAX, character: MAX }, end: { line: MAX, character: MAX } },
  text: '',
})

function splitOne(change: LspContentChange, budget: number): LspContentChange[] {
  const textBudget = budget - 2 - ENVELOPE + 2
  const pieces = chunkText(change.text, Math.max(textBudget, 16))
  const first: LspContentChange = 'range' in change ? { range: change.range, text: pieces[0] } : { text: pieces[0] }
  const out: LspContentChange[] = [first]
  let at = endPosition('range' in change ? change.range.start : { line: 0, character: 0 }, pieces[0])
  for (let i = 1; i < pieces.length; i++) {
    out.push({ range: { start: at, end: at }, text: pieces[i] })
    at = endPosition(at, pieces[i])
  }
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
