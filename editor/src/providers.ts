// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Monaco's language features answered by PHPantom through the bridge: diagnostics, completion, hover,
// signature help, semantic colouring, inlay hints and the outline; then going to definitions and
// references, formatting, rename and code actions. Only what the server says it supports is registered,
// for the model's own language, and only this editor's model is answered.
import type { LspBridge } from './bridge.ts'
import type { EditorContext } from './editor.ts'
import {
  completionDetails,
  completionKindName,
  diagnosticsTouching,
  fromLspRange,
  inlayHintsWanted,
  markdownValue,
  normalizeLocations,
  splitWorkspaceEdit,
  toCodeAction,
  toCompletionLabel,
  toDocumentSymbols,
  toInlayHint,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarker,
  toMonacoEdit,
  toSemanticTokens,
  type LspCodeAction,
  type LspDiagnostic,
  type LspInlayHint,
  type LspTextEdit,
  type LspWorkspaceEdit,
  type MonacoRange
} from './lsp-convert.ts'
import type { monaco } from './monaco.ts'
import { mapLocations, NAVIGATION_NOTE, PeekModels } from './navigation.ts'
import { showNote } from './notes.ts'

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

// Why 30 s: PHPantom may run Pint to format, which can take a while on a cold start.
const FORMAT_TIMEOUT_MS = 30_000
const EDIT_NOTE = 'phpantom-edit'
const OTHER_FILES_FIX = "This fix also changes other files, which isn't supported yet."
const renameReachesOtherFiles = (count: number): string =>
  `Renaming here would also change ${count} other files. Cross-file rename isn't supported yet.`

/** Blade or PHP by the file name, as PHPantom tells them apart. */
const languageOfUri = (uri: string): string => (/\.blade\.php$/i.test(uri) ? 'blade' : 'php')

export function registerEditingProviders(ctx: EditorContext, bridge: LspBridge, capabilities: Record<string, unknown>): Disposable {
  const { monaco, model } = ctx
  const caps = capabilities as Capabilities
  const language = model.getLanguageId()
  const registered: Disposable[] = []
  const ours = (candidate: Model): boolean => candidate === model
  const modelUri = model.uri.toString()
  // Read on each answer: a re-target to another worktree changes it, and providers are registered again then.
  const documentUri = (): string => (bridge.status?.state === 'ready' ? bridge.status.uri : '')
  const ask = (method: string, params: Record<string, unknown>, token: monaco.CancellationToken, options?: { timeoutMs?: number }): Promise<any> =>
    withSignal(token, (signal) => bridge.ask(method, params, signal, options))
  const atCursor = (position: monaco.Position) => ({ position: toLspPosition(position) })
  const edits = (list: LspTextEdit[] | null | undefined): monaco.languages.TextEdit[] | null => (Array.isArray(list) ? list.map(toMonacoEdit) : null)

  // --- definitions and references ---
  const peekModels = new PeekModels((uri, text) => {
    const resource = monaco.Uri.parse(uri)
    // Why check: Monaco throws on a second model for one URI; one made elsewhere is not ours to dispose.
    if (monaco.editor.getModel(resource)) return { dispose() {} }
    return monaco.editor.createModel(text, languageOfUri(uri), resource)
  })
  registered.push(
    peekModels,
    // Peek models stand for files on disk that nothing here saves: an editor showing one (the peek's
    // preview) is read-only, so nobody types into a copy that goes nowhere.
    monaco.editor.onDidCreateEditor((created) => {
      if (created === ctx.editor) return
      const sync = (): void => {
        const shown = created.getModel()
        created.updateOptions({ readOnly: Boolean(shown && peekModels.has(shown.uri.toString())) })
      }
      created.onDidChangeModel(sync)
      sync()
    })
  )

  /** Gives the files `locations` point at a model; those it could not read are left out, with a note. */
  const withPreviews = async (locations: { uri: string; range: MonacoRange }[], token: monaco.CancellationToken) => {
    const files = [...new Set(locations.map((location) => location.uri))].filter((uri) => /^file:/i.test(uri))
    peekModels.touch(files)
    const wanted = files.filter((uri) => !monaco.editor.getModel(monaco.Uri.parse(uri)))
    if (wanted.length === 0) return locations
    const answer = await withSignal(token, (signal) => bridge.peek(wanted, signal))
    // No answer at all: keep every result, so going to one still works without its preview.
    if (!answer) return locations
    peekModels.ensure(answer.files)
    const read = new Set(answer.files.map((file) => file.uri))
    const missing = new Set(wanted.filter((uri) => !read.has(uri)))
    const kept = locations.filter((location) => !missing.has(location.uri))
    const left = locations.length - kept.length
    if (left > 0) showNote('info', `${left} more results are in files not shown here.`, NAVIGATION_NOTE)
    return kept
  }

  const locate = async (method: string, m: Model, position: monaco.Position, token: monaco.CancellationToken, extra: Record<string, unknown> = {}) => {
    if (!ours(m)) return null
    const result = await ask(method, { ...atCursor(position), ...extra }, token)
    const locations = await withPreviews(mapLocations(normalizeLocations(result), documentUri(), modelUri), token)
    return locations.map((location): monaco.languages.Location => ({
      uri: location.uri === modelUri ? model.uri : monaco.Uri.parse(location.uri),
      range: location.range
    }))
  }

  if (caps.definitionProvider) {
    registered.push(
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: (m, position, token) => locate('textDocument/definition', m, position, token)
      })
    )
  }
  if (caps.declarationProvider) {
    registered.push(
      monaco.languages.registerDeclarationProvider(language, {
        provideDeclaration: (m, position, token) => locate('textDocument/declaration', m, position, token)
      })
    )
  }
  if (caps.typeDefinitionProvider) {
    registered.push(
      monaco.languages.registerTypeDefinitionProvider(language, {
        provideTypeDefinition: (m, position, token) => locate('textDocument/typeDefinition', m, position, token)
      })
    )
  }
  if (caps.implementationProvider) {
    registered.push(
      monaco.languages.registerImplementationProvider(language, {
        provideImplementation: (m, position, token) => locate('textDocument/implementation', m, position, token)
      })
    )
  }
  if (caps.referencesProvider) {
    registered.push(
      monaco.languages.registerReferenceProvider(language, {
        provideReferences: (m, position, context, token) =>
          locate('textDocument/references', m, position, token, { context: { includeDeclaration: context.includeDeclaration } })
      })
    )
  }

  // --- formatting ---
  const formatting = (options: monaco.languages.FormattingOptions) => ({ options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } })
  if (caps.documentFormattingProvider) {
    registered.push(
      monaco.languages.registerDocumentFormattingEditProvider(language, {
        displayName: SERVER_NAME,
        async provideDocumentFormattingEdits(m, options, token) {
          if (!ours(m)) return null
          return edits(await ask('textDocument/formatting', formatting(options), token, { timeoutMs: FORMAT_TIMEOUT_MS }))
        }
      })
    )
  }
  if (caps.documentRangeFormattingProvider) {
    registered.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
        displayName: SERVER_NAME,
        async provideDocumentRangeFormattingEdits(m, range, options, token) {
          if (!ours(m)) return null
          return edits(
            await ask('textDocument/rangeFormatting', { range: toLspRange(range), ...formatting(options) }, token, { timeoutMs: FORMAT_TIMEOUT_MS })
          )
        }
      })
    )
  }

  // --- rename, within this file only ---
  if (caps.renameProvider) {
    const prepares = typeof caps.renameProvider === 'object' && Boolean(caps.renameProvider.prepareProvider)
    registered.push(
      monaco.languages.registerRenameProvider(language, {
        resolveRenameLocation: prepares
          ? async (m, position, token) => {
              if (!ours(m)) return null
              const result = await ask('textDocument/prepareRename', atCursor(position), token)
              if (token.isCancellationRequested) throw canceled()
              // Why reject: with nothing returned Monaco would offer to rename the word under the cursor.
              if (!result) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: "This can't be renamed." }
              // The server either leaves the range to the client ...
              if (result.defaultBehavior) return null
              // ... or sends a range, alone or with a placeholder. Why not show the placeholder: for a class
              // PHPantom 1.1.0 sends the fully qualified name while the range and the new name are the short one.
              const range = fromLspRange(result.range ?? result)
              return { range, text: m.getValueInRange(range) }
            }
          : undefined,
        async provideRenameEdits(m, position, newName, token) {
          if (!ours(m)) return null
          const result = (await ask('textDocument/rename', { ...atCursor(position), newName }, token)) as LspWorkspaceEdit | null
          if (!result) return null
          const split = splitWorkspaceEdit(result, documentUri())
          if (split.otherFiles > 0) {
            const reason = renameReachesOtherFiles(split.otherFiles)
            // Why a note too: standalone Monaco only logs a rename's reject reason to the console.
            showNote('info', reason, EDIT_NOTE)
            return { edits: [], rejectReason: reason }
          }
          return { edits: split.own.map((textEdit) => ({ resource: model.uri, textEdit, versionId: undefined })) }
        }
      })
    )
  }

  // --- code actions ---
  if (caps.codeActionProvider) {
    // The server's own action for each one shown: resolving it needs exactly what the server sent.
    const serverActions = new WeakMap<object, LspCodeAction>()
    const kinds = typeof caps.codeActionProvider === 'object' ? caps.codeActionProvider.codeActionKinds : undefined
    const resolves = typeof caps.codeActionProvider === 'object' && Boolean(caps.codeActionProvider.resolveProvider)
    const toMonacoWorkspaceEdit = (edit: { edits: { resource: string; textEdit: monaco.languages.TextEdit }[] }): monaco.languages.WorkspaceEdit => ({
      edits: edit.edits.map((item) => ({ resource: item.resource === modelUri ? model.uri : monaco.Uri.parse(item.resource), textEdit: item.textEdit, versionId: undefined }))
    })
    registered.push(
      monaco.languages.registerCodeActionProvider(
        language,
        {
          async provideCodeActions(m, range, context, token) {
            if (!ours(m)) return { actions: [], dispose() {} }
            const lspRange = toLspRange(range)
            const result = await ask(
              'textDocument/codeAction',
              {
                range: lspRange,
                context: {
                  // As PHPantom sent them: a fix finds its diagnostic by what Monaco's markers drop.
                  diagnostics: diagnosticsTouching(diagnosticsOf(model), lspRange),
                  ...(context.only ? { only: [context.only] } : {}),
                  // Both number these the same way: 1 invoked, 2 automatic.
                  triggerKind: context.trigger
                }
              },
              token
            )
            const actions: monaco.languages.CodeAction[] = []
            for (const raw of Array.isArray(result) ? (result as LspCodeAction[]) : []) {
              const converted = toCodeAction(raw, documentUri(), modelUri)
              if (!converted) continue
              if (converted.needsResolve && !resolves) continue
              const action: monaco.languages.CodeAction = {
                title: converted.title,
                ...(converted.kind ? { kind: converted.kind } : {}),
                ...(converted.isPreferred ? { isPreferred: true } : {}),
                ...(converted.disabled ? { disabled: converted.disabled } : {}),
                // Why not when it reaches other files: Monaco resolves an action that has no edit, and
                // resolving is where that case says why nothing happens.
                ...(converted.edit && converted.otherFiles === 0 ? { edit: toMonacoWorkspaceEdit(converted.edit) } : {})
              }
              serverActions.set(action, raw)
              actions.push(action)
            }
            return { actions, dispose() {} }
          },
          // Monaco calls this unbound, and only for an action that has no edit yet.
          async resolveCodeAction(action, token) {
            const raw = serverActions.get(action)
            if (!raw) return action
            const resolved = raw.edit ? raw : ((await ask('codeAction/resolve', raw as Record<string, unknown>, token)) as LspCodeAction | null)
            if (!resolved) {
              if (token.isCancellationRequested) throw canceled()
              return action
            }
            const converted = toCodeAction(resolved, documentUri(), modelUri)
            if (!converted?.edit) return action
            if (converted.otherFiles > 0) {
              showNote('info', OTHER_FILES_FIX, EDIT_NOTE)
              return action
            }
            return { ...action, edit: toMonacoWorkspaceEdit(converted.edit) }
          }
        },
        kinds ? { providedCodeActionKinds: kinds } : undefined
      )
    )
  }

  return disposeAll(registered)
}
