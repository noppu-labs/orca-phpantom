import { assert, test } from 'orca/testing'
import { DocumentMirror } from '../../src/lsp/mirror.ts'
import { chunkText, encodedSize, REQUEST_BUDGET_BYTES, splitChanges } from './split.ts'

const ins = (line: number, character: number, text: string) => ({
  range: { start: { line, character }, end: { line, character } },
  text,
})

test('small changes stay in one group', () => {
  assert.equal(splitChanges([ins(0, 0, 'a'), ins(0, 1, 'b')]).length, 1)
})

test('split changes rebuild the same text', () => {
  const base = 'x\n'.repeat(1000)
  const big = 'é😀\r\n"quote" \\ tab\t'.repeat(9000)
  const change = { range: { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } }, text: big }
  const expected = new DocumentMirror(base)
  expected.apply([change])
  const actual = new DocumentMirror(base)
  const groups = splitChanges([change])
  assert.ok(groups.length > 1)
  for (const group of groups) {
    assert.ok(encodedSize(group) <= REQUEST_BUDGET_BYTES)
    actual.apply(group)
  }
  assert.equal(actual.text, expected.text)
})

test('split full-text and lone-CR changes rebuild the same text', () => {
  for (const big of ['line\r'.repeat(30000) + 'é', 'a\r\n'.repeat(30000)]) {
    for (const change of [{ text: big }, { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, text: big }]) {
      const base = 'q\n\nr\n'
      const expected = new DocumentMirror(base)
      expected.apply([change])
      const actual = new DocumentMirror(base)
      for (const group of splitChanges([change], 2048)) {
        assert.ok(encodedSize(group) <= 2048)
        actual.apply(group)
      }
      assert.equal(actual.text, expected.text)
    }
  }
})

test('groups keep order and respect the budget', () => {
  const changes = Array.from({ length: 50 }, (_, i) => ins(i, 0, 'abcdefghij'.repeat(10)))
  const groups = splitChanges(changes, 1024)
  assert.ok(groups.length > 1)
  for (const g of groups) assert.ok(encodedSize(g) <= 1024)
  assert.deepEqual(groups.flat(), changes)
})

test('never splits a surrogate pair', () => {
  for (const piece of chunkText('😀'.repeat(40_000), 1024)) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(piece))
})

test('chunkText pieces fit the budget and join back', () => {
  const text = 'a"\\\n\u0001é€😀'.repeat(3000)
  const pieces = chunkText(text, 500)
  for (const p of pieces) assert.ok(encodedSize(p) <= 500)
  assert.equal(pieces.join(''), text)
  assert.deepEqual(chunkText(''), [''])
})
