// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Monaco's editing features answered by PHPantom through the bridge: going to definitions and references, formatting, rename and code actions.
// Only what the server says it supports is registered, for the model's own language, and only this editor's model is answered.
import { isFileUri } from '../../../src/utils/uri.ts';
import type { AskOptions, LspBridge } from '../bridge.ts';
import type { EditorContext } from '../editor.ts';
import {
  diagnosticsTouching,
  fromLspRange,
  isCodeAction,
  isCodeActionList,
  isTextEditList,
  isWorkspaceEdit,
  normalizeLocations,
  renameRange,
  splitWorkspaceEdit,
  toCodeAction,
  toLspPosition,
  toLspRange,
  toMonacoEdit,
  type LspCodeAction,
  type LspPosition,
  type MonacoRange,
  type MonacoWorkspaceEdit,
} from '../lsp-convert.ts';
import type { monaco } from '../monaco.ts';
import {
  afterPeek,
  cutNoteFor,
  mapLocations,
  moreResultsNote,
  NAVIGATION_NOTE,
  PeekModels,
  peekBatch,
} from '../navigation.ts';
import { clearNote, showNote } from '../notes.ts';
import { diagnosticsOf } from './diagnostics.ts';
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

// Why 60 s, twice Orca's default: PHPantom may run Pint to format, which can be slow on a cold start.
const FORMAT_TIMEOUT_MS = 60_000;
const EDIT_NOTE = 'phpantom-edit';
const OTHER_FILES_FIX = "This fix also changes other files, which isn't supported yet.";
const MOVED_FIX = 'The file changed after this fix was offered. Ask for it again.';
const renameReachesOtherFiles = (count: number): string =>
  `Renaming here would also change ${count} other ${count === 1 ? 'file' : 'files'}. Cross-file rename isn't supported yet.`;

/** Blade or PHP by the file name, as PHPantom tells them apart. */
const languageOfUri = (uri: string): string => (/\.blade\.php$/iu.test(uri) ? 'blade' : 'php');

const atCursor = (position: monaco.Position): { position: LspPosition } => ({
  position: toLspPosition(position),
});
const edits = (list: unknown): monaco.languages.TextEdit[] | null =>
  isTextEditList(list) ? list.map((edit) => toMonacoEdit(edit)) : null;
const formatting = (
  options: monaco.languages.FormattingOptions
): { options: { tabSize: number; insertSpaces: boolean } } => ({
  options: { insertSpaces: options.insertSpaces, tabSize: options.tabSize },
});

function registerEditingProviders(
  ctx: EditorContext,
  bridge: LspBridge,
  capabilities: Record<string, unknown>
): Disposable {
  const { monaco, model } = ctx;
  const language = model.getLanguageId();
  const registered: Disposable[] = [];
  const ours = (candidate: Model): boolean => candidate === model;
  const modelUri = model.uri.toString();
  // Read on each answer: a re-target to another worktree changes it, and providers are registered again then.
  const documentUri = (): string => (bridge.status?.state === 'ready' ? bridge.status.uri : '');
  const ask = async (
    method: string,
    params: object,
    token: monaco.CancellationToken,
    options: AskOptions = {}
  ): Promise<unknown> =>
    withSignal(token, async (signal) =>
      bridge.ask(method, params, signal, { kind: 'user', ...options })
    );

  // --- definitions and references ---
  const peekModels = new PeekModels((uri, text) => {
    const resource = monaco.Uri.parse(uri);
    // Why check: Monaco throws on a second model for one URI; one made elsewhere is not ours to dispose.
    if (monaco.editor.getModel(resource)) return { dispose: noop };
    return monaco.editor.createModel(text, languageOfUri(uri), resource);
  });
  registered.push(
    peekModels,
    // Peek models stand for files on disk that nothing here saves: an editor showing one (the peek's preview) is read-only, so nobody types into a copy that goes nowhere.
    monaco.editor.onDidCreateEditor((created) => {
      if (created === ctx.editor) return;
      // Why not at once: the event fires inside the editor's constructor, before it has a model.
      created.onDidChangeModel(() => {
        const shown = created.getModel();
        const peek = Boolean(shown && peekModels.has(shown.uri.toString()));
        // An embedded editor keeps what it is given over its parent's options: never make it writable when the editor it belongs to is read-only.
        created.updateOptions({
          readOnly: peek || ctx.editor.getOption(monaco.editor.EditorOption.readOnly),
        });
      });
    })
  );

  /**
   * Gives the files `locations` point at a model. Those it could not read are left out, with a note,
   * unless `keepUnread`: going to a definition goes through the opener and needs no preview.
   */
  const withPreviews = async (
    locations: { uri: string; range: MonacoRange }[],
    token: monaco.CancellationToken,
    keepUnread: boolean
  ): Promise<{ uri: string; range: MonacoRange }[]> => {
    const files = [...new Set(locations.map((location) => location.uri))].filter((uri) =>
      isFileUri(uri)
    );
    peekModels.touch(files);
    const wanted = files.filter((uri) => !monaco.editor.getModel(monaco.Uri.parse(uri)));
    if (wanted.length === 0) return locations;
    const answer = await withSignal(token, async (signal) =>
      bridge.peek(peekBatch(wanted), signal)
    );
    // No answer at all: keep every result, so going to one still works without its preview.
    if (!answer) return locations;
    peekModels.ensure(answer.files);
    const { shown, left } = afterPeek(
      locations,
      wanted,
      answer.files.map((file) => file.uri),
      keepUnread
    );
    if (left > 0) showNote('info', moreResultsNote(left), NAVIGATION_NOTE);
    return shown;
  };

  const locate = async (
    method: string,
    textModel: Model,
    position: monaco.Position,
    token: monaco.CancellationToken,
    keepUnread: boolean,
    extra: Record<string, unknown> = {}
  ): Promise<monaco.languages.Location[] | null> => {
    if (!ours(textModel)) return null;
    const answer = await withSignal(token, async (signal) =>
      bridge.askDetailed(method, { ...atCursor(position), ...extra }, signal, { kind: 'user' })
    );
    const found = normalizeLocations(answer?.result);
    const locations = await withPreviews(
      mapLocations(found, documentUri(), modelUri),
      token,
      keepUnread
    );
    // Why after the previews: the note counts what is shown, and a query that was not cut clears the last one's.
    if (answer) {
      const cutNote = cutNoteFor(locations.length, answer.truncated);
      if (cutNote !== null && cutNote !== '') showNote('info', cutNote, `${NAVIGATION_NOTE}-cut`);
      else clearNote(`${NAVIGATION_NOTE}-cut`);
    }
    return locations.map((location): monaco.languages.Location => ({
      range: location.range,
      uri: location.uri === modelUri ? model.uri : monaco.Uri.parse(location.uri),
    }));
  };

  if (isTruthy(capabilities.definitionProvider)) {
    registered.push(
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (textModel, position, token) =>
          locate('textDocument/definition', textModel, position, token, true),
      })
    );
  }
  if (isTruthy(capabilities.declarationProvider)) {
    registered.push(
      monaco.languages.registerDeclarationProvider(language, {
        provideDeclaration: async (textModel, position, token) =>
          locate('textDocument/declaration', textModel, position, token, true),
      })
    );
  }
  if (isTruthy(capabilities.typeDefinitionProvider)) {
    registered.push(
      monaco.languages.registerTypeDefinitionProvider(language, {
        provideTypeDefinition: async (textModel, position, token) =>
          locate('textDocument/typeDefinition', textModel, position, token, true),
      })
    );
  }
  if (isTruthy(capabilities.implementationProvider)) {
    registered.push(
      monaco.languages.registerImplementationProvider(language, {
        provideImplementation: async (textModel, position, token) =>
          locate('textDocument/implementation', textModel, position, token, false),
      })
    );
  }
  if (isTruthy(capabilities.referencesProvider)) {
    registered.push(
      monaco.languages.registerReferenceProvider(language, {
        provideReferences: async (textModel, position, context, token) =>
          locate('textDocument/references', textModel, position, token, false, {
            context: { includeDeclaration: context.includeDeclaration },
          }),
      })
    );
  }

  // --- formatting ---
  if (isTruthy(capabilities.documentFormattingProvider)) {
    registered.push(
      monaco.languages.registerDocumentFormattingEditProvider(language, {
        displayName: SERVER_NAME,
        async provideDocumentFormattingEdits(textModel, options, token) {
          if (!ours(textModel)) return null;
          return edits(
            await ask('textDocument/formatting', formatting(options), token, {
              timeoutMs: FORMAT_TIMEOUT_MS,
            })
          );
        },
      })
    );
  }
  if (isTruthy(capabilities.documentRangeFormattingProvider)) {
    registered.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
        displayName: SERVER_NAME,
        async provideDocumentRangeFormattingEdits(textModel, range, options, token) {
          if (!ours(textModel)) return null;
          return edits(
            await ask(
              'textDocument/rangeFormatting',
              { range: toLspRange(range), ...formatting(options) },
              token,
              { timeoutMs: FORMAT_TIMEOUT_MS }
            )
          );
        },
      })
    );
  }

  // --- rename, within this file only ---
  if (isTruthy(capabilities.renameProvider)) {
    const prepares = Boolean(capability(capabilities, 'renameProvider', 'prepareProvider'));
    registered.push(
      monaco.languages.registerRenameProvider(language, {
        async provideRenameEdits(textModel, position, newName, token) {
          if (!ours(textModel)) return null;
          // The bridge drops an answer the text moved under; the stamp makes Monaco refuse it if it moves later.
          const versionId = model.getVersionId();
          const result = await ask(
            'textDocument/rename',
            { ...atCursor(position), newName },
            token
          );
          if (!isTruthy(result)) return null;
          const split = splitWorkspaceEdit(isWorkspaceEdit(result) ? result : null, documentUri());
          if (split.otherFiles > 0) {
            const reason = renameReachesOtherFiles(split.otherFiles);
            // Why a note too: standalone Monaco only logs a rename's reject reason to the console.
            showNote('info', reason, EDIT_NOTE);
            return { edits: [], rejectReason: reason };
          }
          return {
            edits: split.own.map((textEdit) => ({ resource: model.uri, textEdit, versionId })),
          };
        },
        resolveRenameLocation: prepares
          ? async (textModel, position, token) => {
              if (!ours(textModel)) return null;
              const result = await ask('textDocument/prepareRename', atCursor(position), token);
              if (token.isCancellationRequested) throw canceled();
              // Why reject: with nothing returned Monaco would offer to rename the word under the cursor.
              if (!isTruthy(result)) {
                return {
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column
                  ),
                  rejectReason: "This can't be renamed.",
                  text: '',
                };
              }
              // The server either leaves the range to the client ...
              if (isRecord(result) && isTruthy(result.defaultBehavior)) return null;
              // ... or sends a range, alone or with a placeholder. Why not show the placeholder: for a class PHPantom 1.1.0 sends the fully qualified name while the range and the new name are the short one.
              const range = fromLspRange(renameRange(result));
              return { range, text: textModel.getValueInRange(range) };
            }
          : undefined,
      })
    );
  }

  // --- code actions ---
  if (isTruthy(capabilities.codeActionProvider)) {
    // The server's own action for each one shown, and the model version it was computed against: resolving needs exactly what the server sent, and an edit applies only to that version's text.
    const serverActions = new WeakMap<object, { raw: LspCodeAction; versionId: number }>();
    const kinds = listOrUndefined(
      capability(capabilities, 'codeActionProvider', 'codeActionKinds')
    );
    const resolves = Boolean(capability(capabilities, 'codeActionProvider', 'resolveProvider'));
    const toMonacoWorkspaceEdit = (edit: MonacoWorkspaceEdit): monaco.languages.WorkspaceEdit => ({
      edits: edit.edits.map((item) => ({
        ...item,
        resource: item.resource === modelUri ? model.uri : monaco.Uri.parse(item.resource),
      })),
    });
    registered.push(
      monaco.languages.registerCodeActionProvider(
        language,
        {
          async provideCodeActions(textModel, range, context, token) {
            if (!ours(textModel)) return { actions: [], dispose: noop };
            const lspRange = toLspRange(range);
            // Why: the lightbulb outlives typing, so an action must not carry an edit for older text.
            const versionId = model.getVersionId();
            const result = await ask(
              'textDocument/codeAction',
              {
                context: {
                  // As PHPantom sent them: a fix finds its diagnostic by what Monaco's markers drop.
                  diagnostics: diagnosticsTouching(diagnosticsOf(model), lspRange),
                  ...(context.only === undefined || context.only === ''
                    ? {}
                    : { only: [context.only] }),
                  // Both number these the same way: 1 invoked, 2 automatic.
                  triggerKind: context.trigger,
                },
                range: lspRange,
              },
              token,
              // The lightbulb asks on every cursor move; only an invoked one (1) is someone asking. Silent: hovering a diagnostic asks as invoked too.
              context.trigger === 1 ? { kind: 'user', silent: true } : { kind: 'background' }
            );
            const actions: monaco.languages.CodeAction[] = [];
            if (model.getVersionId() !== versionId) return { actions, dispose: noop };
            for (const raw of isCodeActionList(result) ? result : []) {
              const converted = toCodeAction(raw, documentUri(), modelUri, versionId);
              if (!converted) continue;
              if (converted.needsResolve && !resolves) continue;
              const action: monaco.languages.CodeAction = {
                title: converted.title,
                ...(converted.kind === undefined || converted.kind === ''
                  ? {}
                  : { kind: converted.kind }),
                ...(isTruthy(converted.isPreferred) ? { isPreferred: true } : {}),
                ...(converted.disabled === undefined || converted.disabled === ''
                  ? {}
                  : { disabled: converted.disabled }),
                // Why not when it reaches other files: Monaco resolves an action that has no edit, and resolving is where that case says why nothing happens.
                ...(converted.edit && converted.otherFiles === 0
                  ? { edit: toMonacoWorkspaceEdit(converted.edit) }
                  : {}),
              };
              serverActions.set(action, { raw, versionId });
              actions.push(action);
            }
            return { actions, dispose: noop };
          },
          // Monaco calls this unbound, and only for an action that has no edit yet.
          async resolveCodeAction(action, token) {
            const offered = serverActions.get(action);
            if (!offered) return action;
            const { raw, versionId } = offered;
            // The action's own ranges are against the text it was offered for; resolving it now would place its edit wrongly.
            if (model.getVersionId() !== versionId) {
              showNote('info', MOVED_FIX, EDIT_NOTE);
              return action;
            }
            const resolved = raw.edit ? raw : await ask('codeAction/resolve', raw, token);
            if (!isTruthy(resolved)) {
              if (token.isCancellationRequested) throw canceled();
              return action;
            }
            // Anything but an object is no action.
            if (!isCodeAction(resolved)) return action;
            const converted = toCodeAction(resolved, documentUri(), modelUri, versionId);
            if (!converted?.edit) return action;
            if (converted.otherFiles > 0) {
              showNote('info', OTHER_FILES_FIX, EDIT_NOTE);
              return action;
            }
            return { ...action, edit: toMonacoWorkspaceEdit(converted.edit) };
          },
        },
        kinds ? { providedCodeActionKinds: kinds } : undefined
      )
    );
  }

  return disposeAll(registered);
}

export { languageOfUri, registerEditingProviders, renameReachesOtherFiles };
