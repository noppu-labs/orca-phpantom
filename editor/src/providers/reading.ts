// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Monaco's reading features answered by PHPantom through the bridge: completion, hover, signature help, semantic colouring, inlay hints and the outline.
// Only what the server says it supports is registered, for the model's own language, and only this editor's model is answered.
import type { LspBridge, RequestKind } from '../bridge.ts';
import type { EditorContext } from '../editor.ts';
import {
  completionDetails,
  completionItems,
  completionKindName,
  fromLspRange,
  inlayHintsWanted,
  isHover,
  isInlayHintList,
  isSemanticTokensLegend,
  isSignatureHelp,
  isSymbolList,
  markdownValue,
  toCompletionLabel,
  toDocumentSymbols,
  toInlayHint,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMonacoEdit,
  toSemanticTokens,
  type LspCompletionItem,
  type LspPosition,
  type LspTextEdit,
} from '../lsp-convert.ts';
import type { monaco } from '../monaco.ts';
import {
  SERVER_NAME,
  canceled,
  capability,
  disposeAll,
  isRecord,
  isTruthy,
  listOrUndefined,
  noop,
  withSignal,
  type Disposable,
  type Model,
} from './shared.ts';

function registerReadingProviders(
  ctx: EditorContext,
  bridge: LspBridge,
  capabilities: Record<string, unknown>
): Disposable {
  const { monaco, model } = ctx;
  const language = model.getLanguageId();
  const registered: Disposable[] = [];
  const ours = (candidate: Model): boolean => candidate === model;
  const ask = async (
    method: string,
    params: object,
    token: monaco.CancellationToken,
    kind: RequestKind,
    silent = false
  ): Promise<unknown> =>
    withSignal(token, async (signal) => bridge.ask(method, params, signal, { kind, silent }));
  const atCursor = (position: monaco.Position): { position: LspPosition } => ({
    position: toLspPosition(position),
  });
  const edits = (list: LspTextEdit[]): monaco.languages.TextEdit[] => list.map(toMonacoEdit);

  // --- completion ---
  if (isTruthy(capabilities.completionProvider)) {
    // The server's own item for each suggestion shown: resolving it needs exactly what the server sent.
    const serverItems = new WeakMap<object, LspCompletionItem>();
    registered.push(
      monaco.languages.registerCompletionItemProvider(language, {
        async provideCompletionItems(textModel, position, context, token) {
          if (!ours(textModel)) return { suggestions: [] };
          const result = await ask(
            'textDocument/completion',
            {
              ...atCursor(position),
              // Monaco counts trigger kinds from 0, LSP from 1, in the same order.
              context: {
                triggerKind: context.triggerKind + 1,
                ...(context.triggerCharacter === undefined || context.triggerCharacter === ''
                  ? {}
                  : { triggerCharacter: context.triggerCharacter }),
              },
            },
            token,
            // Why passive even for "invoked" (0): Monaco reports quick suggestions while typing that way too.
            'passive'
          );
          const items = completionItems(result);
          const word = textModel.getWordUntilPosition(position);
          const fallback = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn
          );
          return {
            incomplete: isRecord(result) && Boolean(result.isIncomplete),
            suggestions: items.map((item) => {
              const edit = item.textEdit;
              const range = edit
                ? edit.range
                  ? fromLspRange(edit.range)
                  : { insert: fromLspRange(edit.insert), replace: fromLspRange(edit.replace) }
                : fallback;
              const suggestion: monaco.languages.CompletionItem = {
                additionalTextEdits: item.additionalTextEdits
                  ? edits(item.additionalTextEdits)
                  : undefined,
                commitCharacters: item.commitCharacters,
                detail: item.detail,
                documentation: markdownValue(item.documentation),
                filterText: item.filterText,
                insertText: edit?.newText ?? item.insertText ?? item.label,
                insertTextRules:
                  item.insertTextFormat === 2
                    ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                    : undefined,
                kind: monaco.languages.CompletionItemKind[completionKindName(item.kind)],
                label: toCompletionLabel(item),
                preselect: item.preselect,
                range,
                sortText: item.sortText,
                tags:
                  isTruthy(item.deprecated) || item.tags?.includes(1) === true
                    ? [monaco.languages.CompletionItemTag.Deprecated]
                    : undefined,
              };
              serverItems.set(suggestion, item);
              return suggestion;
            }),
          };
        },
        // Why: PHPantom sends the `use` import that goes with a class from another namespace only here.
        resolveCompletionItem: isTruthy(
          capability(capabilities, 'completionProvider', 'resolveProvider')
        )
          ? async (suggestion, token) => {
              const raw = serverItems.get(suggestion);
              if (!raw) return suggestion;
              // Why user, not passive: Monaco also resolves here when the item is accepted, and a dropped answer would lose the import.
              // Silent: it resolves every item that gets focus, too.
              const resolved = await ask('completionItem/resolve', raw, token, 'user', true);
              // Monaco resolves an item once; one with no answer must say so to be resolved again later.
              if (resolved === null) throw canceled();
              return { ...suggestion, ...completionDetails(resolved) };
            }
          : undefined,
        triggerCharacters: listOrUndefined(
          capability(capabilities, 'completionProvider', 'triggerCharacters')
        ),
      })
    );
  }

  // --- hover and signature help ---
  if (isTruthy(capabilities.hoverProvider)) {
    registered.push(
      monaco.languages.registerHoverProvider(language, {
        async provideHover(textModel, position, token) {
          if (!ours(textModel)) return null;
          const result = await ask('textDocument/hover', atCursor(position), token, 'passive');
          const hover = isHover(result) ? result : undefined;
          const contents = toMarkdown(hover?.contents).map((value) => ({ value }));
          return contents.length > 0
            ? { contents, ...(hover?.range ? { range: fromLspRange(hover.range) } : {}) }
            : null;
        },
      })
    );
  }
  if (isTruthy(capabilities.signatureHelpProvider)) {
    registered.push(
      monaco.languages.registerSignatureHelpProvider(language, {
        async provideSignatureHelp(textModel, position, token, context) {
          if (!ours(textModel)) return null;
          const result = await ask(
            'textDocument/signatureHelp',
            {
              ...atCursor(position),
              // Both number these trigger kinds the same way: 1 invoked, 2 character, 3 content change.
              context: {
                isRetrigger: context.isRetrigger,
                triggerKind: context.triggerKind,
                ...(context.triggerCharacter === undefined || context.triggerCharacter === ''
                  ? {}
                  : { triggerCharacter: context.triggerCharacter }),
              },
            },
            token,
            // Why passive even for "invoked": Monaco invokes it itself, after a completion that adds parentheses.
            'passive'
          );
          const help = isSignatureHelp(result) ? result : undefined;
          if (help === undefined || !isTruthy(help.signatures?.length)) return null;
          return {
            dispose: noop,
            value: {
              activeParameter: help.activeParameter ?? 0,
              activeSignature: help.activeSignature ?? 0,
              signatures: help.signatures.map((signature) => ({
                documentation: markdownValue(signature.documentation),
                label: signature.label,
                // A label is either the text or [start, end] offsets into the signature's label, in both.
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  documentation: markdownValue(parameter.documentation),
                  label: parameter.label,
                })),
                ...(typeof signature.activeParameter === 'number'
                  ? { activeParameter: signature.activeParameter }
                  : {}),
              })),
            },
          };
        },
        signatureHelpRetriggerCharacters: listOrUndefined(
          capability(capabilities, 'signatureHelpProvider', 'retriggerCharacters')
        ),
        signatureHelpTriggerCharacters: listOrUndefined(
          capability(capabilities, 'signatureHelpProvider', 'triggerCharacters')
        ),
      })
    );
  }

  // --- semantic colouring ---
  const legend = capability(capabilities, 'semanticTokensProvider', 'legend');
  if (
    isSemanticTokensLegend(legend) &&
    isTruthy(capability(capabilities, 'semanticTokensProvider', 'full'))
  ) {
    const changed = new monaco.Emitter<void>();
    registered.push(
      changed,
      bridge.onRefresh((kinds) => {
        if (kinds.includes('semanticTokens')) changed.fire();
      }),
      monaco.languages.registerDocumentSemanticTokensProvider(language, {
        getLegend: () => legend,
        onDidChange: changed.event,
        async provideDocumentSemanticTokens(textModel, _lastResultId, token) {
          if (!ours(textModel)) return null;
          const tokens = toSemanticTokens(
            await ask('textDocument/semanticTokens/full', {}, token, 'background')
          );
          // Why throw: Monaco wipes the colouring on an empty answer but keeps it on an error, and a message with "busy" in it is not reported.
          // No answer means not now, not "no tokens".
          if (!tokens) throw new Error('PHPantom is busy');
          return tokens;
        },
        releaseDocumentSemanticTokens: noop,
      })
    );
  }

  // --- inlay hints ---
  if (inlayHintsWanted(language, capabilities)) {
    const changed = new monaco.Emitter<void>();
    registered.push(
      changed,
      bridge.onRefresh((kinds) => {
        if (kinds.includes('inlayHints')) changed.fire();
      }),
      monaco.languages.registerInlayHintsProvider(language, {
        displayName: SERVER_NAME,
        onDidChangeInlayHints: changed.event,
        async provideInlayHints(textModel, range, token) {
          if (!ours(textModel)) return null;
          const result = await ask(
            'textDocument/inlayHint',
            { range: toLspRange(range) },
            token,
            'background'
          );
          if (!isInlayHintList(result)) return null;
          // oxlint-disable-next-line typescript/no-unsafe-enum-assignment -- LSP and Monaco number inlay hint kinds the same way (1 type, 2 parameter)
          return { dispose: noop, hints: result.map(toInlayHint) };
        },
      })
    );
  }

  // --- the outline ---
  if (isTruthy(capabilities.documentSymbolProvider)) {
    registered.push(
      monaco.languages.registerDocumentSymbolProvider(language, {
        displayName: SERVER_NAME,
        async provideDocumentSymbols(textModel, token) {
          if (!ours(textModel)) return null;
          const result = await ask('textDocument/documentSymbol', {}, token, 'background');
          return isSymbolList(result) ? toDocumentSymbols(result) : null;
        },
      })
    );
  }

  return disposeAll(registered);
}

export { registerReadingProviders };
