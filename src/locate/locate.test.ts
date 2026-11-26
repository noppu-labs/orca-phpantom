import { assert, test } from 'orca/testing'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { locateFile } from './locate.ts'

const made: string[] = []

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'phpantom-locate-'))
  made.push(root)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), text)
  }
  return root
}

async function twoWorktrees(files: Record<string, string>): Promise<[string, string]> {
  return [await tree(files), await tree(files)]
}

async function cleanup(): Promise<void> {
  await Promise.all(made.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

const SRC = '<?php class Example {}\n'

test('prefers the focused worktree when both copies match', async () => {
  const [a, b] = await twoWorktrees({ 'app/Example.php': SRC })
  try {
    assert.deepEqual(await locateFile({ tiers: [[b], [a]], candidates: [], language: 'php', content: SRC }), {
      status: 'found',
      path: join(b, 'app/Example.php'),
      root: b
    })
  } finally {
    await cleanup()
  }
})

test('two identical files inside the focused workspace are ambiguous and do not fall through', async () => {
  const a = await tree({ 'x.php': SRC, 'y.php': SRC })
  const b = await tree({ 'z.php': SRC })
  try {
    assert.deepEqual(await locateFile({ tiers: [[a], [b]], candidates: [], language: 'php', content: SRC }), {
      status: 'ambiguous'
    })
  } finally {
    await cleanup()
  }
})

test('nothing in the focused workspace falls through to the others', async () => {
  const a = await tree({ 'other.php': '<?php echo 1;\n' })
  const b = await tree({ 'app/Example.php': SRC })
  try {
    assert.deepEqual(await locateFile({ tiers: [[a], [b]], candidates: [], language: 'php', content: SRC }), {
      status: 'found',
      path: join(b, 'app/Example.php'),
      root: b
    })
  } finally {
    await cleanup()
  }
})

test('a pending reveal path wins even inside vendor', async () => {
  const a = await tree({ 'vendor/lib/Thing.php': SRC })
  const path = join(a, 'vendor/lib/Thing.php')
  try {
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [path], language: 'php', content: SRC }), {
      status: 'found',
      path,
      root: a
    })
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC }), { status: 'none' })
  } finally {
    await cleanup()
  }
})

test('a pending reveal path with edited text is found by likeness', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `$line${i} = ${i};`)
  const a = await tree({ 'vendor/V.php': ['<?php', ...lines].join('\n') + '\n' })
  const path = join(a, 'vendor/V.php')
  const edited = ['<?php', ...lines.map((l, i) => (i < 2 ? `${l} // x` : l))].join('\n') + '\n'
  try {
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [path], language: 'php', content: edited }), {
      status: 'found',
      path,
      root: a,
      approximate: true
    })
  } finally {
    await cleanup()
  }
})

test('blade and php documents never match each other', async () => {
  const text = '<div>{{ $x }}</div>\n'
  const a = await tree({ 'welcome.blade.php': text, 'welcome.php': text })
  try {
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [], language: 'blade', content: text }), {
      status: 'found',
      path: join(a, 'welcome.blade.php'),
      root: a
    })
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: text }), {
      status: 'found',
      path: join(a, 'welcome.php'),
      root: a
    })
  } finally {
    await cleanup()
  }
})

test('storage and vendor folders are skipped by the walk', async () => {
  const a = await tree({ 'storage/framework/views/x.php': SRC, 'vendor/v/y.php': SRC })
  try {
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC }), { status: 'none' })
  } finally {
    await cleanup()
  }
})

test('an edited document is found by likeness', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `$line${i} = ${i};`)
  const original = ['<?php', ...lines].join('\n') + '\n'
  const edited = ['<?php', ...lines.map((l, i) => (i < 2 ? `${l} // x` : l))].join('\n') + '\n'
  const a = await tree({ 'a.php': original, 'b.php': '<?php\necho "unrelated";\n' })
  try {
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: edited }), {
      status: 'found',
      path: join(a, 'a.php'),
      root: a,
      approximate: true
    })
  } finally {
    await cleanup()
  }
})

test('a byte order mark does not stop an exact match', async () => {
  const a = await tree({ 'bom.php': '﻿' + SRC })
  try {
    assert.deepEqual(await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC }), {
      status: 'found',
      path: join(a, 'bom.php'),
      root: a
    })
  } finally {
    await cleanup()
  }
})
