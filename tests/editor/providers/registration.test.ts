import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LspBridge } from '../../../editor/src/bridge.ts';
import type { EditorContext } from '../../../editor/src/editor.ts';
import { registerEditingProviders } from '../../../editor/src/providers/editing.ts';
import { registerReadingProviders } from '../../../editor/src/providers/reading.ts';

// A Monaco that records each provider registered, and a bridge that answers each method from a table.
// Pins which values of a capability or an answer each provider takes as "there", so the condition rewrite keeps it.

const disposable = { dispose() {} };

function fakeContext() {
  const registrations: { name: string; provider: any }[] = [];
  const languages = new Proxy(
    {
      CompletionItemKind: new Proxy({}, { get: (_target, key) => String(key) }),
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      CompletionItemTag: { Deprecated: 1 },
    },
    {
      get(target, key) {
        if (typeof key === 'string' && key.startsWith('register')) {
          return (_language: string, provider: unknown) => {
            registrations.push({ name: key, provider });
            return disposable;
          };
        }
        return Reflect.get(target, key);
      },
    }
  );
  class Range {
    public constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number
    ) {}
  }
  class Emitter {
    public event = () => disposable;
    public fire() {}
    public dispose() {}
  }
  const monaco = {
    languages,
    Range,
    Emitter,
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      getModel: () => null,
      createModel: () => disposable,
      onDidCreateEditor: () => disposable,
      EditorOption: { readOnly: 0 },
    },
  };
  const model = {
    getLanguageId: () => 'php',
    uri: { toString: () => 'inmemory://model/1' },
    getVersionId: () => 1,
    getValueInRange: () => 'name',
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }),
  };
  const ctx = {
    monaco,
    model,
    editor: { getOption: () => false },
    docId: 'd1',
    language: 'php',
  } as unknown as EditorContext;
  const provider = (name: string): any => {
    const found = registrations.find((registration) => registration.name === name);
    assert.ok(found, `${name} was not registered`);
    return found.provider;
  };
  return { ctx, model, registrations, provider };
}

function fakeBridge(answers: Record<string, unknown> = {}) {
  const asked: { method: string; params: any }[] = [];
  const answer = (method: string): unknown => (method in answers ? answers[method] : null);
  const bridge = {
    status: { state: 'ready', uri: 'file:///w/A.php', session: 's', capabilities: {} },
    ask: async (method: string, params: object) => {
      asked.push({ method, params });
      return answer(method);
    },
    askDetailed: async (method: string, params: object) => {
      asked.push({ method, params });
      return { result: answer(method), truncated: 0 };
    },
    peek: async () => null,
    onRefresh: () => disposable,
  };
  return { bridge: bridge as unknown as LspBridge, asked, answers };
}

const token = { isCancellationRequested: false, onCancellationRequested: () => disposable };
const position = { lineNumber: 1, column: 1 };
const FALSY = [undefined, false, null, 0, '', Number.NaN];

const EDITING_KEYS = [
  'definitionProvider',
  'declarationProvider',
  'typeDefinitionProvider',
  'implementationProvider',
  'referencesProvider',
  'documentFormattingProvider',
  'documentRangeFormattingProvider',
  'renameProvider',
  'codeActionProvider',
];
const READING_KEYS = [
  'completionProvider',
  'hoverProvider',
  'signatureHelpProvider',
  'documentSymbolProvider',
  'semanticTokensProvider',
  'inlayHintProvider',
];

function registerAll(capabilities: Record<string, unknown>, answers: Record<string, unknown> = {}) {
  const context = fakeContext();
  const { bridge, asked } = fakeBridge(answers);
  registerEditingProviders(context.ctx, bridge, capabilities);
  registerReadingProviders(context.ctx, bridge, capabilities);
  return { ...context, asked };
}

test('a capability that is falsy registers nothing; true or an object registers its provider', () => {
  for (const value of FALSY) {
    const capabilities = Object.fromEntries(
      [...EDITING_KEYS, ...READING_KEYS].map((key) => [key, value])
    );
    assert.deepEqual(registerAll(capabilities).registrations, [], String(value));
  }
  assert.deepEqual(registerAll({}).registrations, []);
  for (const value of [true, {}]) {
    const capabilities = Object.fromEntries(
      [...EDITING_KEYS, ...READING_KEYS].map((key) => [key, value])
    );
    assert.deepEqual(
      registerAll(capabilities)
        .registrations.map((registration) => registration.name)
        .sort(),
      [
        'registerCodeActionProvider',
        'registerCompletionItemProvider',
        'registerDeclarationProvider',
        'registerDefinitionProvider',
        'registerDocumentFormattingEditProvider',
        'registerDocumentRangeFormattingEditProvider',
        'registerDocumentSymbolProvider',
        'registerHoverProvider',
        'registerImplementationProvider',
        'registerInlayHintsProvider',
        'registerReferenceProvider',
        'registerRenameProvider',
        'registerSignatureHelpProvider',
        'registerTypeDefinitionProvider',
      ],
      JSON.stringify(value)
    );
  }
});

test('completion resolves, and semantic tokens register, only when the nested capability is truthy', () => {
  const legend = { tokenTypes: [], tokenModifiers: [] };
  for (const value of FALSY) {
    const { provider, registrations } = registerAll({
      completionProvider: { resolveProvider: value },
      semanticTokensProvider: { legend, full: value },
    });
    assert.equal(provider('registerCompletionItemProvider').resolveCompletionItem, undefined);
    assert.equal(
      registrations.some((registration) => registration.name.includes('SemanticTokens')),
      false
    );
  }
  for (const value of [true, {}]) {
    const { provider } = registerAll({
      completionProvider: { resolveProvider: value },
      semanticTokensProvider: { legend, full: value },
    });
    assert.equal(
      typeof provider('registerCompletionItemProvider').resolveCompletionItem,
      'function'
    );
    provider('registerDocumentSemanticTokensProvider');
  }
});

test('a falsy rename answer renames nothing', async () => {
  for (const value of FALSY) {
    const { provider, model } = registerAll(
      { renameProvider: true },
      { 'textDocument/rename': value }
    );
    assert.equal(
      await provider('registerRenameProvider').provideRenameEdits(model, position, 'x', token),
      null,
      String(value)
    );
  }
});

test('a falsy prepareRename answer rejects; a falsy defaultBehavior is read as a range', async () => {
  for (const value of FALSY) {
    const { provider, model } = registerAll(
      { renameProvider: { prepareProvider: true } },
      { 'textDocument/prepareRename': value }
    );
    const answer = await provider('registerRenameProvider').resolveRenameLocation(
      model,
      position,
      token
    );
    assert.equal(answer.rejectReason, "This can't be renamed.", String(value));
  }
  for (const value of FALSY) {
    const { provider, model } = registerAll(
      { renameProvider: { prepareProvider: true } },
      { 'textDocument/prepareRename': { defaultBehavior: value } }
    );
    await assert.rejects(
      provider('registerRenameProvider').resolveRenameLocation(model, position, token),
      /no range/u,
      String(value)
    );
  }
  const { provider, model } = registerAll(
    { renameProvider: { prepareProvider: true } },
    { 'textDocument/prepareRename': { defaultBehavior: true } }
  );
  assert.equal(
    await provider('registerRenameProvider').resolveRenameLocation(model, position, token),
    null
  );
});

test('code actions leave out an empty only, kind and reason, and a false isPreferred', async () => {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  for (const only of ['', undefined]) {
    const { provider, model, asked } = registerAll(
      { codeActionProvider: { resolveProvider: true } },
      {
        'textDocument/codeAction': [
          { title: 'a', data: 1, kind: '', isPreferred: false, disabled: { reason: '' } },
          { title: 'b', data: 1 },
        ],
      }
    );
    const list = await provider('registerCodeActionProvider').provideCodeActions(
      model,
      range,
      { trigger: 1, ...(only === undefined ? {} : { only }) },
      token
    );
    assert.equal('only' in asked[0].params.context, false, String(only));
    assert.deepEqual(list.actions, [{ title: 'a' }, { title: 'b' }]);
  }
});

test('a falsy codeAction/resolve answer leaves the action as it was', async () => {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  for (const value of FALSY) {
    const { provider, model } = registerAll(
      { codeActionProvider: { resolveProvider: true } },
      { 'textDocument/codeAction': [{ title: 'a', data: 1 }], 'codeAction/resolve': value }
    );
    const codeActions = provider('registerCodeActionProvider');
    const list = await codeActions.provideCodeActions(model, range, { trigger: 1 }, token);
    const [action] = list.actions;
    assert.equal(await codeActions.resolveCodeAction(action, token), action, String(value));
  }
});

test('completion leaves out an empty trigger character and marks deprecated only when told', async () => {
  for (const triggerCharacter of ['', undefined]) {
    const { provider, model, asked } = registerAll(
      { completionProvider: {} },
      {
        'textDocument/completion': [
          { label: 'a', deprecated: false, tags: [] },
          { label: 'b', tags: [2] },
          { label: 'c', deprecated: true },
          { label: 'd', tags: [1] },
        ],
      }
    );
    const list = await provider('registerCompletionItemProvider').provideCompletionItems(
      model,
      position,
      { triggerKind: 0, ...(triggerCharacter === undefined ? {} : { triggerCharacter }) },
      token
    );
    assert.equal('triggerCharacter' in asked[0].params.context, false, String(triggerCharacter));
    assert.deepEqual(
      list.suggestions.map((suggestion: any) => suggestion.tags),
      [undefined, undefined, [1], [1]]
    );
  }
});

test('signature help leaves out an empty trigger character and answers null for no signatures', async () => {
  for (const result of [null, {}, { signatures: [] }]) {
    for (const triggerCharacter of ['', undefined]) {
      const { provider, model, asked } = registerAll(
        { signatureHelpProvider: {} },
        { 'textDocument/signatureHelp': result }
      );
      const help = await provider('registerSignatureHelpProvider').provideSignatureHelp(
        model,
        position,
        token,
        {
          isRetrigger: false,
          triggerKind: 1,
          ...(triggerCharacter === undefined ? {} : { triggerCharacter }),
        }
      );
      assert.equal(help, null, JSON.stringify(result));
      assert.equal('triggerCharacter' in asked[0].params.context, false);
    }
  }
});

test('going to a definition that found nothing shows no note about cut results', async () => {
  const { provider, model } = registerAll(
    { definitionProvider: true },
    { 'textDocument/definition': [] }
  );
  assert.deepEqual(
    await provider('registerDefinitionProvider').provideDefinition(model, position, token),
    []
  );
});

test('completion marks a truthy non-boolean deprecated, and not a null one', async () => {
  const { provider, model } = registerAll(
    { completionProvider: {} },
    {
      'textDocument/completion': [
        { label: 'a', deprecated: 1 },
        { label: 'b', deprecated: null },
      ],
    }
  );
  const list = await provider('registerCompletionItemProvider').provideCompletionItems(
    model,
    position,
    { triggerKind: 0 },
    token
  );
  assert.deepEqual(
    list.suggestions.map((suggestion: any) => suggestion.tags),
    [[1], undefined]
  );
});

test('a code action a server marks preferred with a truthy non-boolean is preferred', async () => {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  const { provider, model } = registerAll(
    { codeActionProvider: { resolveProvider: true } },
    { 'textDocument/codeAction': [{ title: 'a', data: 1, isPreferred: 1 }] }
  );
  const list = await provider('registerCodeActionProvider').provideCodeActions(
    model,
    range,
    { trigger: 1 },
    token
  );
  assert.deepEqual(list.actions, [{ title: 'a', isPreferred: true }]);
});
