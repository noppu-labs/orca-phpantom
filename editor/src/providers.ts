// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Monaco's language features answered by PHPantom through the bridge: diagnostics, completion, hover,
// signature help, semantic colouring, inlay hints and the outline. Only what the server says it supports
// is registered, for the model's own language, and only this editor's model is answered.
import type { LspBridge } from './bridge.ts'
import type { EditorContext } from './editor.ts'
import {
  completionDetails,
  completionKindName,
  fromLspRange,
  inlayHintsWanted,
  markdownValue,
  toCompletionLabel,
  toDocumentSymbols,
  toInlayHint,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarker,
  toMonacoEdit,
  toSemanticTokens,
  type LspDiagnostic,
  type LspInlayHint,
  type LspTextEdit
} from './lsp-convert.ts'
import type { monaco } from './monaco.ts'

type Disposable = { dispose(): void }
type Capabilities = Record<string, any> // the server's own JSON
type Model = monaco.editor.ITextModel

const MARKER_OWNER = 'phpantom'
const SERVER_NAME = 'PHPantom'

const diagnosticsByModel = new WeakMap<Model, LspDiagnostic[]>()

/** The diagnostics PHPantom last published for `model`, as it sent them; code actions send them back. */
export function diagnosticsOf(model: Model): LspDiagnostic[] {
  return diagnosticsByModel.get(model) ?? []
}

/**
 * Keeps PHPantom's diagnostics for this editor and shows them as markers. Call it before attaching:
 * PHPantom publishes while the open is still answering, before any provider is registered.
 */
export function showDiagnostics(ctx: EditorContext, bridge: LspBridge): Disposable {
  const set = (diagnostics: LspDiagnostic[]): void => {
    diagnosticsByModel.set(ctx.model, diagnostics)
    ctx.monaco.editor.setModelMarkers(ctx.model, MARKER_OWNER, diagnostics.map(toMarker))
  }
  return disposeAll([
    bridge.onDiagnostics((diagnostics) => set(diagnostics as LspDiagnostic[])),
    bridge.onStatus((status) => {
      if (status.state !== 'ready') set([])
    })
  ])
}

/** Monaco's cancellation token as an AbortSignal for one request. */
async function withSignal<T>(token: monaco.CancellationToken, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  const listener = token.onCancellationRequested(() => controller.abort())
  try {
    return await run(controller.signal)
  } finally {
    listener.dispose()
  }
}

/** The error Monaco takes as a cancellation: a resolve that ends this way is asked again later. */
function canceled(): Error {
  const error = new Error('Canceled')
  error.name = 'Canceled'
  return error
}

function disposeAll(list: Disposable[]): Disposable {
  return {
    dispose() {
      for (const item of list.splice(0)) item.dispose()
    }
  }
}

export function registerReadingProviders(ctx: EditorContext, bridge: LspBridge, capabilities: Record<string, unknown>): Disposable {
  const { monaco, model } = ctx
  const caps = capabilities as Capabilities
  const language = model.getLanguageId()
  const registered: Disposable[] = []
  const ours = (candidate: Model): boolean => candidate === model
  const ask = (method: string, params: Record<string, unknown>, token: monaco.CancellationToken): Promise<any> =>
    withSignal(token, (signal) => bridge.ask(method, params, signal))
  const atCursor = (position: monaco.Position) => ({ position: toLspPosition(position) })
  const edits = (list: LspTextEdit[]): monaco.languages.TextEdit[] => list.map(toMonacoEdit)

  // --- completion ---
  if (caps.completionProvider) {
    // The server's own item for each suggestion shown: resolving it needs exactly what the server sent.
    const serverItems = new WeakMap<object, Record<string, unknown>>()
    registered.push(
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: caps.completionProvider.triggerCharacters,
        async provideCompletionItems(m, position, context, token) {
          if (!ours(m)) return { suggestions: [] }
          const result = await ask(
            'textDocument/completion',
            {
              ...atCursor(position),
              // Monaco counts trigger kinds from 0, LSP from 1, in the same order.
              context: { triggerKind: context.triggerKind + 1, ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}) }
            },
            token
          )
          const items: any[] = Array.isArray(result) ? result : (result?.items ?? [])
          const word = m.getWordUntilPosition(position)
          const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          return {
            incomplete: Boolean(result?.isIncomplete),
            suggestions: items.map((item) => {
              const edit = item.textEdit
              const range = edit
                ? edit.range
                  ? fromLspRange(edit.range)
                  : { insert: fromLspRange(edit.insert), replace: fromLspRange(edit.replace) }
                : fallback
              const suggestion: monaco.languages.CompletionItem = {
                label: toCompletionLabel(item),
                kind: monaco.languages.CompletionItemKind[completionKindName(item.kind) as keyof typeof monaco.languages.CompletionItemKind],
                detail: item.detail,
                documentation: markdownValue(item.documentation),
                insertText: edit?.newText ?? item.insertText ?? item.label,
                insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                range,
                sortText: item.sortText,
                filterText: item.filterText,
                preselect: item.preselect,
                commitCharacters: item.commitCharacters,
                additionalTextEdits: item.additionalTextEdits ? edits(item.additionalTextEdits) : undefined,
                tags: item.deprecated || item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined
              }
              serverItems.set(suggestion, item)
              return suggestion
            })
          }
        },
        // Why: PHPantom sends the `use` import that goes with a class from another namespace only here.
        resolveCompletionItem: caps.completionProvider.resolveProvider
          ? async (suggestion, token) => {
              const raw = serverItems.get(suggestion)
              if (!raw) return suggestion
              const resolved = await ask('completionItem/resolve', raw, token)
              // Monaco resolves an item once; a cancelled one must say so to be resolved again later.
              if (resolved === null && token.isCancellationRequested) throw canceled()
              return { ...suggestion, ...completionDetails(resolved) }
            }
          : undefined
      })
    )
  }

  // --- hover and signature help ---
  if (caps.hoverProvider) {
    registered.push(
      monaco.languages.registerHoverProvider(language, {
        async provideHover(m, position, token) {
          if (!ours(m)) return null
          const result = await ask('textDocument/hover', atCursor(position), token)
          const contents = toMarkdown(result?.contents).map((value) => ({ value }))
          return contents.length ? { contents, ...(result.range ? { range: fromLspRange(result.range) } : {}) } : null
        }
      })
    )
  }
  if (caps.signatureHelpProvider) {
    registered.push(
      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters,
        signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters,
        async provideSignatureHelp(m, position, token, context) {
          if (!ours(m)) return null
          const result = await ask(
            'textDocument/signatureHelp',
            {
              ...atCursor(position),
              // Both number these trigger kinds the same way: 1 invoked, 2 character, 3 content change.
              context: {
                triggerKind: context.triggerKind,
                isRetrigger: context.isRetrigger,
                ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {})
              }
            },
            token
          )
          if (!result?.signatures?.length) return null
          return {
            value: {
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
              signatures: result.signatures.map((signature: any) => ({
                label: signature.label,
                documentation: markdownValue(signature.documentation),
                // A label is either the text or [start, end] offsets into the signature's label, in both.
                parameters: (signature.parameters ?? []).map((parameter: any) => ({
                  label: parameter.label,
                  documentation: markdownValue(parameter.documentation)
                })),
                ...(typeof signature.activeParameter === 'number' ? { activeParameter: signature.activeParameter } : {})
              }))
            },
            dispose() {}
          }
        }
      })
    )
  }

  // --- semantic colouring ---
  const semantic = caps.semanticTokensProvider
  if (semantic?.legend && semantic.full) {
    const changed = new monaco.Emitter<void>()
    registered.push(
      changed,
      bridge.onRefresh((kinds) => {
        if (kinds.includes('semanticTokens')) changed.fire()
      }),
      monaco.languages.registerDocumentSemanticTokensProvider(language, {
        onDidChange: changed.event,
        getLegend: () => semantic.legend,
        async provideDocumentSemanticTokens(m, _lastResultId, token) {
          if (!ours(m)) return null
          const tokens = toSemanticTokens(await ask('textDocument/semanticTokens/full', {}, token))
          // Why throw: Monaco wipes the colouring on an empty answer but keeps it on an error, and a
          // message with "busy" in it is not reported. No answer means not now, not "no tokens".
          if (!tokens) throw new Error('PHPantom is busy')
          return tokens
        },
        releaseDocumentSemanticTokens() {}
      })
    )
  }

  // --- inlay hints ---
  if (inlayHintsWanted(language, caps)) {
    const changed = new monaco.Emitter<void>()
    registered.push(
      changed,
      bridge.onRefresh((kinds) => {
        if (kinds.includes('inlayHints')) changed.fire()
      }),
      monaco.languages.registerInlayHintsProvider(language, {
        displayName: SERVER_NAME,
        onDidChangeInlayHints: changed.event,
        async provideInlayHints(m, range, token) {
          if (!ours(m)) return null
          const result = await ask('textDocument/inlayHint', { range: toLspRange(range) }, token)
          if (!Array.isArray(result)) return null
          return { hints: (result as LspInlayHint[]).map(toInlayHint), dispose() {} }
        }
      })
    )
  }

  // --- the outline ---
  if (caps.documentSymbolProvider) {
    registered.push(
      monaco.languages.registerDocumentSymbolProvider(language, {
        displayName: SERVER_NAME,
        async provideDocumentSymbols(m, token) {
          if (!ours(m)) return null
          const result = await ask('textDocument/documentSymbol', {}, token)
          return Array.isArray(result) ? (toDocumentSymbols(result) as monaco.languages.DocumentSymbol[]) : null
        }
      })
    )
  }

  return disposeAll(registered)
}
