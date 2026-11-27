import assert from 'node:assert/strict'
import { test } from 'node:test'
import { afterPeek, cutNoteFor, cutResultsNote, mapLocations, moreResultsNote, PeekModels, peekBatch } from './navigation.ts'
import { renameReachesOtherFiles } from './providers.ts'

const r = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => ({ startLineNumber, startColumn, endLineNumber, endColumn })

test('own-file locations point at the in-memory model', () => {
  assert.deepEqual(mapLocations([{ uri: 'file:///w/a.php', range: r(1, 1, 1, 4) }, { uri: 'file:///w/B.php', range: r(9, 21, 9, 21) }], 'file:///w/a.php', 'inmemory://phpantom/d1.php'),
    [{ uri: 'inmemory://phpantom/d1.php', range: r(1, 1, 1, 4) }, { uri: 'file:///w/B.php', range: r(9, 21, 9, 21) }])
})

test('own-file locations match whichever way the server spells the URI', () => {
  assert.deepEqual(mapLocations([{ uri: 'file:///c%3A/w/a.php', range: r(1, 1, 1, 1) }], 'file:///C:/w/a.php', 'inmemory://phpantom/d1.php'), [
    { uri: 'inmemory://phpantom/d1.php', range: r(1, 1, 1, 1) }
  ])
})

function recorder(limit?: number) {
  const made: string[] = []
  const disposed: string[] = []
  const peek = new PeekModels((uri) => {
    made.push(uri)
    return { dispose: () => void disposed.push(uri) }
  }, limit)
  return { made, disposed, peek }
}

const file = (name: string) => ({ uri: `file:///w/${name}.php`, text: `<?php // ${name}` })

test('peek models are capped and least recently used go first', () => {
  const { disposed, peek } = recorder(2)
  peek.ensure([file('a'), file('b'), file('c')])
  assert.deepEqual(disposed, ['file:///w/a.php'])
  assert.equal(peek.has('file:///w/a.php'), false)
  assert.equal(peek.has('file:///w/b.php'), true)
  assert.equal(peek.has('file:///w/c.php'), true)
})

test('a peek model an answer uses again is kept over older ones', () => {
  const { made, disposed, peek } = recorder(2)
  peek.ensure([file('a'), file('b')])
  peek.touch(['file:///w/a.php'])
  peek.ensure([file('a'), file('c')])
  assert.deepEqual(made, ['file:///w/a.php', 'file:///w/b.php', 'file:///w/c.php'])
  assert.deepEqual(disposed, ['file:///w/b.php'])
})

test('disposing drops every peek model', () => {
  const { disposed, peek } = recorder()
  peek.ensure([file('a'), file('b')])
  peek.dispose()
  assert.deepEqual(disposed.sort(), ['file:///w/a.php', 'file:///w/b.php'])
  assert.equal(peek.has('file:///w/a.php'), false)
})

const B = 'file:///w/B.php'
const C = 'file:///w/C.php'
const inB = { uri: B, range: r(1, 1, 1, 1) }
const inC = { uri: C, range: r(2, 1, 2, 1) }
const own = { uri: 'inmemory://phpantom/d1.php', range: r(3, 1, 3, 1) }

test('references leave out locations in files peek did not read', () => {
  assert.deepEqual(afterPeek([own, inB, inC, inC], [B, C], [B], false), { shown: [own, inB], left: 2 })
})

test('a definition keeps its location without a preview, so going to it still works', () => {
  assert.deepEqual(afterPeek([inC], [C], [], true), { shown: [inC], left: 0 })
})

test('notes count in the singular and the plural', () => {
  assert.equal(moreResultsNote(1), '1 more result is in a file not shown here.')
  assert.equal(moreResultsNote(3), '3 more results are in files not shown here.')
  assert.equal(cutResultsNote(1, 1), 'Showing the first 1 result; 1 more was cut.')
  assert.equal(cutResultsNote(2400, 3600), 'Showing the first 2400 results; 3600 more were cut.')
  assert.equal(renameReachesOtherFiles(1), "Renaming here would also change 1 other file. Cross-file rename isn't supported yet.")
  assert.equal(renameReachesOtherFiles(4), "Renaming here would also change 4 other files. Cross-file rename isn't supported yet.")
})

test('the cut note counts what is shown and goes away when nothing was cut', () => {
  assert.equal(cutNoteFor(2, 5), 'Showing the first 2 results; 5 more were cut.')
  assert.equal(cutNoteFor(2, 0), null)
})

test('a peek asks for at most 25 files; locations in the rest are left out with the note count', () => {
  const wanted = Array.from({ length: 30 }, (_, i) => `file:///w/F${i}.php`)
  const asked = peekBatch(wanted)
  assert.deepEqual(asked, wanted.slice(0, 25))
  const locations = wanted.map((uri) => ({ uri, range: r(1, 1, 1, 1) }))
  // The worker read every file it was asked for; the five never asked for count as left out.
  const { shown, left } = afterPeek(locations, wanted, asked, false)
  assert.equal(shown.length, 25)
  assert.equal(left, 5)
})
