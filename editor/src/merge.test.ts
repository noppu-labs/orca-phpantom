import { assert, test } from 'orca/testing'
import { mergeText } from './merge.ts'

test('takes the outside text when only the file changed', () => {
  assert.deepEqual(mergeText('a\nb\n', 'a\nB\n', 'a\nb\n'), { text: 'a\nB\n', conflicts: 0 })
})
test('keeps both when they touch different lines', () => {
  assert.deepEqual(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n'), { text: 'A\nb\nC\n', conflicts: 0 })
})
test('keeps both sides when an agent rewrites the lines being edited', () => {
  assert.deepEqual(mergeText('a\nb\nc\n', 'a\nB2\nc\n', 'a\nB1\nc\n'), {
    text: 'a\n<<<<<<< your unsaved edits\nB1\n=======\nB2\n>>>>>>> file on disk\nc\n', conflicts: 1
  })
})
test('treats the same change on both sides as no conflict', () => {
  assert.deepEqual(mergeText('a\n', 'b\n', 'b\n'), { text: 'b\n', conflicts: 0 })
})
test('merges a 1 MB file well inside the 1 s answer budget', () => {
  const base = Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}\n`).join('')
  const mine = base.replace('line 10 ', 'line ten ')
  const outside = base.replace('line 29000 ', 'line 29k ')
  const started = performance.now()
  const merged = mergeText(base, outside, mine)
  assert.ok(performance.now() - started < 400)
  assert.equal(merged.conflicts, 0)
  assert.ok(merged.text.includes('line ten ') && merged.text.includes('line 29k '))
})
