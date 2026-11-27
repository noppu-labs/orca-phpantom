// Adapted from actus7/orca-autocomplete editor/src/lsp-convert.test.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  completionDetails,
  completionItems,
  completionKindName,
  diagnosticsTouching,
  fromLspRange,
  inlayHintsWanted,
  isCodeAction,
  isDiagnosticList,
  isHover,
  isSemanticTokensLegend,
  isSignatureHelp,
  isWorkspaceEdit,
  markdownValue,
  markerSeverity,
  normalizeLocations,
  renameRange,
  splitWorkspaceEdit,
  toDocumentSymbols,
  toLspPosition,
  toLspContentChange,
  toLspRange,
  toCodeAction,
  toCompletionLabel,
  toInlayHint,
  toMarkdown,
  toMarker,
  toSemanticTokens,
} from '../../editor/src/lsp-convert.ts';

test('positions and ranges convert between 0-based LSP and 1-based Monaco, and back', () => {
  assert.deepEqual(toLspPosition({ lineNumber: 3, column: 5 }), { line: 2, character: 4 });
  const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 7 } };
  assert.deepEqual(fromLspRange(range), {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: 8,
  });
  assert.deepEqual(toLspRange(fromLspRange(range)), range);
});

test('severity maps to Monaco markers and defaults to error', () => {
  assert.deepEqual([1, 2, 3, 4, undefined].map(markerSeverity), [8, 4, 2, 1, 8]);
});

test('toMarker keeps the message, code, source and tags', () => {
  const marker = toMarker({
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    severity: 2,
    code: { value: 'E0308' },
    source: 'rustc',
    message: 'mismatched types',
    tags: [1],
  });
  assert.deepEqual(marker, {
    startLineNumber: 2,
    startColumn: 3,
    endLineNumber: 2,
    endColumn: 6,
    severity: 4,
    message: 'mismatched types',
    code: 'E0308',
    source: 'rustc',
    tags: [1],
  });
});

test('completionKindName covers the LSP kinds and falls back to Text', () => {
  assert.equal(completionKindName(3), 'Function');
  assert.equal(completionKindName(22), 'Struct');
  assert.equal(completionKindName(99), 'Text');
  assert.equal(completionKindName(undefined), 'Text');
});

test('toMarkdown accepts every hover shape', () => {
  assert.deepEqual(toMarkdown('plain'), ['plain']);
  assert.deepEqual(toMarkdown({ kind: 'markdown', value: '**x**' }), ['**x**']);
  assert.deepEqual(toMarkdown({ language: 'ts', value: 'let a' }), ['```ts\nlet a\n```']);
  assert.deepEqual(toMarkdown(['a', { language: 'rs', value: 'fn' }, '']), ['a', '```rs\nfn\n```']);
  assert.deepEqual(toMarkdown({ kind: 'plaintext', value: 'a_b *c*' }), [String.raw`a\_b \*c\*`]);
  assert.deepEqual(toMarkdown(null), []);
});

test('normalizeLocations handles a single location, a list and links', () => {
  const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } };
  assert.equal(normalizeLocations({ uri: 'file:///a', range }).length, 1);
  assert.equal(
    normalizeLocations([
      { uri: 'file:///a', range },
      { uri: 'file:///b', range },
    ]).length,
    2
  );
  assert.deepEqual(
    normalizeLocations([
      { targetUri: 'file:///c', targetRange: range, targetSelectionRange: range },
    ])[0].uri,
    'file:///c'
  );
  assert.deepEqual(normalizeLocations(null), []);
});

test('splitWorkspaceEdit separates this document from other files', () => {
  const edit = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const split = splitWorkspaceEdit(
    {
      changes: { 'file:///a': [{ range: edit, newText: 'x' }] },
      documentChanges: [
        { textDocument: { uri: 'file:///b' }, edits: [{ range: edit, newText: 'y' }] },
      ],
    },
    'file:///a'
  );
  assert.equal(split.own.length, 1);
  assert.equal(split.own[0].text, 'x');
  assert.equal(split.otherFiles, 1);
  assert.deepEqual(splitWorkspaceEdit(null, 'file:///a'), { own: [], otherFiles: 0 });
});

test('toDocumentSymbols converts a tree and a flat list', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } };
  const tree = toDocumentSymbols([
    { name: 'A', kind: 5, range, selectionRange: range, children: [{ name: 'm', kind: 6, range }] },
  ]) as { kind: number; children: { kind: number }[] }[];
  assert.equal(tree[0].kind, 4);
  assert.equal(tree[0].children[0].kind, 5);
  const flat = toDocumentSymbols([
    { name: 'f', kind: 12, location: { range }, containerName: 'mod' },
  ]) as { detail: string }[];
  assert.equal(flat[0].detail, 'mod');
  assert.deepEqual(toDocumentSymbols(null), []);
});

test('markdownValue joins every part of the documentation and says nothing when there is none', () => {
  assert.deepEqual(markdownValue('plain'), { value: 'plain' });
  assert.deepEqual(markdownValue(['a', 'b']), { value: 'a\n\nb' });
  assert.equal(markdownValue(undefined), undefined);
  assert.equal(markdownValue(''), undefined);
});

// Why: a TypeScript server only says which import goes with a suggestion when asked to resolve it.
test('what a server resolves for a completion item is turned into what Monaco applies when it is picked', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const resolved = {
    detail: 'class Money',
    documentation: { kind: 'markdown', value: 'An amount.' },
    additionalTextEdits: [{ range, newText: "import { Money } from './money'\n" }],
  };
  assert.deepEqual(completionDetails(resolved), {
    detail: 'class Money',
    documentation: { value: 'An amount.' },
    additionalTextEdits: [
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        text: "import { Money } from './money'\n",
      },
    ],
  });
});

test('a resolved item that adds nothing adds nothing, so what the list already showed stays', () => {
  assert.deepEqual(completionDetails({}), {});
  assert.deepEqual(completionDetails({ additionalTextEdits: [], documentation: '' }), {});
  assert.deepEqual(completionDetails(null), {});
  assert.deepEqual(completionDetails(undefined), {});
});

test('content changes keep Monaco ranges as zero-based LSP ranges', () => {
  assert.deepEqual(
    toLspContentChange({
      range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 5 },
      text: 'x',
    }),
    { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, text: 'x' }
  );
});

test('completion labels carry PHPantom label details', () => {
  assert.deepEqual(
    toCompletionLabel({
      label: 'greet($who)',
      labelDetails: { detail: ': string', description: 'User' },
    }),
    { label: 'greet($who)', detail: ': string', description: 'User' }
  );
  assert.equal(toCompletionLabel({ label: 'name' }), 'name');
});
test('inlay hints move to one-based positions and keep their kind', () => {
  assert.deepEqual(
    toInlayHint({
      position: { line: 12, character: 28 },
      label: 'who:',
      kind: 2,
      tooltip: 'string $who',
      paddingRight: true,
    }),
    {
      label: 'who:',
      position: { lineNumber: 13, column: 29 },
      kind: 2,
      tooltip: 'string $who',
      paddingRight: true,
    }
  );
});
test('semantic tokens become a Uint32Array', () => {
  assert.deepEqual([...toSemanticTokens({ data: [3, 21, 2, 6, 32] })!.data], [3, 21, 2, 6, 32]);
  assert.equal(toSemanticTokens(null), null);
});

// Why: PHPantom 1.1.0 hints Blade's compiled view (`value:` after `{{`, `args:` in directives), not the code.
test('inlay hints are asked for in PHP only, and only when the server offers them', () => {
  assert.equal(inlayHintsWanted('php', { inlayHintProvider: true }), true);
  assert.equal(inlayHintsWanted('blade', { inlayHintProvider: true }), false);
  assert.equal(inlayHintsWanted('php', {}), false);
});

const U = 'file:///w/app/A.php';
const M = 'inmemory://phpantom/d1.php';
const at = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

test('a data-only action needs resolve; a bare command is dropped', () => {
  assert.equal(
    toCodeAction(
      {
        title: 'Extract function',
        kind: 'refactor.extract',
        data: { action_kind: 'refactor.extractFunction' },
      },
      U,
      M
    )?.needsResolve,
    true
  );
  assert.equal(
    toCodeAction(
      { title: 'Run', command: { title: 'x', command: 'phpantom.navigateToPrototype' } },
      U,
      M
    ),
    null
  );
});

test('an action with edits to other files reports them', () => {
  const action = toCodeAction(
    {
      title: 'Implement interface',
      kind: 'quickfix',
      isPreferred: true,
      edit: {
        changes: {
          [U]: [{ range: at(2, 0, 0), newText: 'use B;\n' }],
          'file:///w/app/B.php': [{ range: at(0, 0, 0), newText: 'x' }],
        },
      },
    },
    U,
    M
  );
  assert.equal(action?.otherFiles, 1);
  assert.equal(action?.needsResolve, false);
  assert.equal(action?.isPreferred, true);
  assert.deepEqual(action?.edit, {
    edits: [
      {
        resource: M,
        textEdit: {
          range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 },
          text: 'use B;\n',
        },
        versionId: undefined,
      },
    ],
  });
});

test('a file create, rename or delete in an edit counts as another file', () => {
  const action = toCodeAction(
    {
      title: 'Move class',
      edit: { documentChanges: [{ kind: 'create', uri: 'file:///w/app/C.php' } as never] },
    },
    U,
    M
  );
  assert.equal(action?.otherFiles, 1);
  assert.deepEqual(action?.edit, { edits: [] });
});

test('code actions get back the diagnostics that touch the range, as the server sent them', () => {
  const near = { range: at(4, 2, 9), message: 'unused import', data: { id: 7 } };
  const far = { range: at(10, 0, 3), message: 'elsewhere' };
  const touching = { range: at(5, 0, 1), message: 'starts where the range ends' };
  assert.deepEqual(
    diagnosticsTouching([near, far, touching], {
      start: { line: 4, character: 9 },
      end: { line: 5, character: 0 },
    }),
    [near, touching]
  );
});

test('an action computed against a version carries it on every edit, so Monaco refuses it once the text moves', () => {
  const action = toCodeAction(
    {
      title: 'Alias',
      kind: 'refactor.rewrite',
      edit: { changes: { [U]: [{ range: at(6, 4, 4), newText: 'X' }] } },
    },
    U,
    M,
    12
  );
  assert.equal(action?.edit?.edits[0].versionId, 12);
});

// Odd answers: the guards branch as reading the fields directly would.
test('completionItems reads a list or a CompletionList, and throws on items that are not a list', () => {
  const item = { label: 'a' };
  assert.deepEqual(completionItems([item]), [item]);
  assert.deepEqual(completionItems({ isIncomplete: true, items: [item] }), [item]);
  for (const nothing of [null, undefined, true, 'abc', 3, {}, { items: null }]) {
    assert.deepEqual(completionItems(nothing), []);
  }
  for (const broken of [{ items: 'abc' }, { items: {} }, { items: 0 }]) {
    assert.throws(() => completionItems(broken), TypeError);
  }
  // The same objects, not copies: resolving sends the server back exactly what it sent.
  const list = [item];
  assert.equal(completionItems(list), list);
});

test('completionDetails of anything but an object is nothing', () => {
  for (const odd of [true, 'abc', 3, [], [{ detail: 'x' }]]) {
    assert.deepEqual(completionDetails(odd), {});
  }
});

test('renameRange takes the range, or the answer itself when it is a bare range', () => {
  const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  assert.equal(renameRange(range), range);
  assert.equal(renameRange({ range, placeholder: 'Foo' }), range);
  // A null range falls back to the answer itself, as `result.range ?? result` did.
  const bare = { range: null, ...range };
  assert.equal(renameRange(bare), bare);
  for (const broken of [true, 'abc', 3, [], {}, { start: null, end: range.end }, { range: 5 }]) {
    assert.throws(() => renameRange(broken), TypeError);
  }
});

test('normalizeLocations throws on a location that is not an object, as reading it did', () => {
  assert.throws(() => normalizeLocations([null]), TypeError);
  assert.throws(() => normalizeLocations('file:///a'), TypeError);
  assert.throws(() => normalizeLocations([[]]), TypeError);
  assert.deepEqual(normalizeLocations(undefined), []);
  assert.deepEqual(normalizeLocations(0), []);
});

test('semantic tokens need an object with a data list', () => {
  for (const odd of [true, 'abc', [], { data: 'abc' }, { data: null }]) {
    assert.equal(toSemanticTokens(odd), null);
  }
  // Each entry is converted as Uint32Array.from converts it, numbers or not.
  assert.deepEqual([...toSemanticTokens({ data: ['3', 'x'] })!.data], [3, 0]);
});

test('a semantic tokens legend needs both of its lists', () => {
  assert.equal(isSemanticTokensLegend({ tokenModifiers: [], tokenTypes: [] }), true);
  for (const odd of [
    true,
    'abc',
    [],
    {},
    { tokenTypes: [] },
    { tokenModifiers: [], tokenTypes: 'a' },
  ]) {
    assert.equal(isSemanticTokensLegend(odd), false);
  }
});

test('a diagnostics list is shown only when every entry is an object', () => {
  assert.equal(isDiagnosticList([]), true);
  assert.equal(isDiagnosticList([{ message: 'm' }]), true);
  assert.equal(isDiagnosticList([{ message: 'm' }, null]), false);
  assert.equal(isDiagnosticList([[]]), false);
});

test('object guards reject null, arrays and other values, as reading a field from them gave nothing', () => {
  for (const guard of [isCodeAction, isHover, isSignatureHelp, isWorkspaceEdit]) {
    for (const odd of [null, undefined, true, 'abc', 3, []]) {
      assert.equal(guard(odd), false);
    }
    assert.equal(guard({}), true);
  }
});
