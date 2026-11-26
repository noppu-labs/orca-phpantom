import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapLocations, PeekModels } from './navigation.ts'

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
