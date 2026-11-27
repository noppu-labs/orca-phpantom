import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { assert, test } from 'orca/testing';

import { PHP_EXTENSIONS, locateFile } from '../../../../src/services/locate/locate.ts';

const made: string[] = [];

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'phpantom-locate-'));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

async function twoWorktrees(files: Record<string, string>): Promise<[string, string]> {
  return [await tree(files), await tree(files)];
}

async function cleanup(): Promise<void> {
  await Promise.all(made.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

const SRC = '<?php class Example {}\n';

test('prefers the focused worktree when both copies match', async () => {
  const [a, b] = await twoWorktrees({ 'app/Example.php': SRC });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[b], [a]], candidates: [], language: 'php', content: SRC }),
      {
        status: 'found',
        path: join(b, 'app/Example.php'),
        root: b,
      }
    );
  } finally {
    await cleanup();
  }
});

test('two identical files inside the focused workspace are ambiguous and do not fall through', async () => {
  const a = await tree({ 'x.php': SRC, 'y.php': SRC });
  const b = await tree({ 'z.php': SRC });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a], [b]], candidates: [], language: 'php', content: SRC }),
      {
        status: 'ambiguous',
      }
    );
  } finally {
    await cleanup();
  }
});

test('nothing in the focused workspace falls through to the others', async () => {
  const a = await tree({ 'other.php': '<?php echo 1;\n' });
  const b = await tree({ 'app/Example.php': SRC });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a], [b]], candidates: [], language: 'php', content: SRC }),
      {
        status: 'found',
        path: join(b, 'app/Example.php'),
        root: b,
      }
    );
  } finally {
    await cleanup();
  }
});

test('a pending reveal path wins even inside vendor', async () => {
  const a = await tree({ 'composer.json': '{}', 'vendor/lib/Thing.php': SRC });
  const path = join(a, 'vendor/lib/Thing.php');
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [path], language: 'php', content: SRC }),
      {
        status: 'found',
        path,
        root: a,
      }
    );
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC }),
      { status: 'none' }
    );
  } finally {
    await cleanup();
  }
});

test('a pending reveal path with edited text is found by likeness', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `$line${i} = ${i};`);
  const a = await tree({ 'vendor/V.php': ['<?php', ...lines].join('\n') + '\n' });
  const path = join(a, 'vendor/V.php');
  const edited = ['<?php', ...lines.map((l, i) => (i < 2 ? `${l} // x` : l))].join('\n') + '\n';
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [path], language: 'php', content: edited }),
      {
        status: 'found',
        path,
        root: a,
        approximate: true,
      }
    );
  } finally {
    await cleanup();
  }
});

test('blade and php documents never match each other', async () => {
  const text = '<div>{{ $x }}</div>\n';
  const a = await tree({ 'welcome.blade.php': text, 'welcome.php': text });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'blade', content: text }),
      {
        status: 'found',
        path: join(a, 'welcome.blade.php'),
        root: a,
      }
    );
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: text }),
      {
        status: 'found',
        path: join(a, 'welcome.php'),
        root: a,
      }
    );
  } finally {
    await cleanup();
  }
});

test('vendor and storage beside composer.json are skipped by the walk', async () => {
  const a = await tree({
    'composer.json': '{}',
    'storage/framework/views/x.php': SRC,
    'vendor/v/y.php': SRC,
  });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC }),
      { status: 'none' }
    );
  } finally {
    await cleanup();
  }
});

test('an edited document is found by likeness', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `$line${i} = ${i};`);
  const original = ['<?php', ...lines].join('\n') + '\n';
  const edited = ['<?php', ...lines.map((l, i) => (i < 2 ? `${l} // x` : l))].join('\n') + '\n';
  const a = await tree({ 'a.php': original, 'b.php': '<?php\necho "unrelated";\n' });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: edited }),
      {
        status: 'found',
        path: join(a, 'a.php'),
        root: a,
        approximate: true,
      }
    );
  } finally {
    await cleanup();
  }
});

test('a byte order mark does not stop an exact match', async () => {
  const a = await tree({ 'bom.php': '﻿' + SRC });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC }),
      {
        status: 'found',
        path: join(a, 'bom.php'),
        root: a,
      }
    );
  } finally {
    await cleanup();
  }
});

test('published views under resources/views/vendor are located, a root vendor beside composer.json is not', async () => {
  const text = '<nav>{{ $links }}</nav>\n';
  const a = await tree({
    'composer.json': '{}',
    'resources/views/vendor/pagination/x.blade.php': text,
    'vendor/pkg/y.blade.php': '<p>{{ $y }}</p>\n',
  });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[a]], candidates: [], language: 'blade', content: text }),
      {
        status: 'found',
        path: join(a, 'resources/views/vendor/pagination/x.blade.php'),
        root: a,
      }
    );
    assert.deepEqual(
      await locateFile({
        tiers: [[a]],
        candidates: [],
        language: 'blade',
        content: '<p>{{ $y }}</p>\n',
      }),
      { status: 'none' }
    );
  } finally {
    await cleanup();
  }
});

test('app/Library is walked', async () => {
  const a = await tree({ 'app/Library/Tool.php': SRC });
  try {
    assert.equal(
      (await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC })).status,
      'found'
    );
  } finally {
    await cleanup();
  }
});

test('a zero time budget stops the walk before any directory is read', async () => {
  const a = await tree({ 'a/Example.php': SRC });
  try {
    assert.deepEqual(
      await locateFile(
        { tiers: [[a]], candidates: [], language: 'php', content: SRC },
        { budgetMs: -1 }
      ),
      {
        status: 'none',
      }
    );
  } finally {
    await cleanup();
  }
});

test('the file cap bounds the walk, directories included', async () => {
  const a = await tree({ 'a/b/c/Example.php': SRC });
  try {
    assert.deepEqual(
      await locateFile(
        { tiers: [[a]], candidates: [], language: 'php', content: SRC },
        { maxFiles: 0 }
      ),
      {
        status: 'none',
      }
    );
    assert.deepEqual(
      await locateFile(
        { tiers: [[a]], candidates: [], language: 'php', content: SRC },
        { maxFiles: 2 }
      ),
      {
        status: 'none',
      }
    );
    assert.equal(
      (await locateFile({ tiers: [[a]], candidates: [], language: 'php', content: SRC })).status,
      'found'
    );
  } finally {
    await cleanup();
  }
});

test('a remembered path the walk cannot reach is found when its text matches exactly', async () => {
  const root = await tree({
    'composer.json': '{}',
    'app/A.php': '<?php // a\n',
    'vendor/x/Y.php': SRC,
  });
  try {
    const known = [join(root, 'vendor/x/Y.php')];
    assert.deepEqual(
      await locateFile({ tiers: [[root]], candidates: [], known, language: 'php', content: SRC }),
      { status: 'found', path: join(root, 'vendor/x/Y.php'), root }
    );
    // Exact matches only: edited text is not placed from memory.
    assert.deepEqual(
      await locateFile({
        tiers: [[root]],
        candidates: [],
        known,
        language: 'php',
        content: SRC + '// edited\n',
      }),
      { status: 'none' }
    );
  } finally {
    await cleanup();
  }
});

test("a path remembered in a sibling worktree still attaches to the focused worktree's copy", async () => {
  const [focused, sibling] = await twoWorktrees({ 'composer.json': '{}', 'vendor/x/Y.php': SRC });
  try {
    const known = [join(sibling, 'vendor/x/Y.php')];
    assert.deepEqual(
      await locateFile({
        tiers: [[focused], [sibling]],
        candidates: [],
        known,
        language: 'php',
        content: SRC,
      }),
      {
        status: 'found',
        path: join(focused, 'vendor/x/Y.php'),
        root: focused,
      }
    );
  } finally {
    await cleanup();
  }
});

test('a remembered file with an identical copy beside it is still ambiguous', async () => {
  // Say the person duplicated an open file and opened the copy: it must not attach as the original.
  const root = await tree({ 'app/X.php': SRC, 'app/Y.php': SRC });
  try {
    assert.deepEqual(
      await locateFile({
        tiers: [[root]],
        candidates: [],
        known: [join(root, 'app/X.php')],
        language: 'php',
        content: SRC,
      }),
      { status: 'ambiguous' }
    );
    // A remembered file the walk also finds is one match, not two.
    await rm(join(root, 'app/Y.php'));
    assert.deepEqual(
      await locateFile({
        tiers: [[root]],
        candidates: [],
        known: [join(root, 'app/X.php')],
        language: 'php',
        content: SRC,
      }),
      { status: 'found', path: join(root, 'app/X.php'), root }
    );
  } finally {
    await cleanup();
  }
});

test('each Drupal extension is found as a php document', async () => {
  for (const extension of ['.module', '.install', '.theme', '.profile', '.inc', '.engine']) {
    const root = await tree({ [`web/modules/custom/acme/acme${extension}`]: SRC });
    try {
      assert.deepEqual(
        await locateFile({ tiers: [[root]], candidates: [], language: 'php', content: SRC }),
        {
          status: 'found',
          path: join(root, `web/modules/custom/acme/acme${extension}`),
          root,
        }
      );
    } finally {
      await cleanup();
    }
  }
});

test('an upper-case Drupal extension matches, as Orca ignores case', async () => {
  const root = await tree({ 'ACME.MODULE': SRC });
  try {
    assert.equal(
      (await locateFile({ tiers: [[root]], candidates: [], language: 'php', content: SRC })).status,
      'found'
    );
  } finally {
    await cleanup();
  }
});

test('a file named only an extension is never a php document', async () => {
  const root = await tree({ '.profile': SRC, '.inc': SRC });
  try {
    assert.deepEqual(
      await locateFile({
        tiers: [[root]],
        candidates: [join(root, '.profile')],
        language: 'php',
        content: SRC,
      }),
      { status: 'none' }
    );
  } finally {
    await cleanup();
  }
});

test('a blade document never matches a Drupal extension', async () => {
  const root = await tree({ 'acme.module': SRC });
  try {
    assert.deepEqual(
      await locateFile({ tiers: [[root]], candidates: [], language: 'blade', content: SRC }),
      { status: 'none' }
    );
  } finally {
    await cleanup();
  }
});

test("the manifest's php editor opens exactly the extensions the locator accepts", async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../../orca-plugin.json', import.meta.url), 'utf8')
  );
  const editors = manifest.contributes.customEditors as { id: string; extensions: string[] }[];
  assert.deepEqual(
    [...editors.find((editor) => editor.id === 'php')!.extensions].sort(),
    [...PHP_EXTENSIONS].sort()
  );
  assert.deepEqual(editors.find((editor) => editor.id === 'blade')!.extensions, ['.blade.php']);
});
