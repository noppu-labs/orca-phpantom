// Adapted from actus7/orca-autocomplete editor/src/main.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Monaco in Orca's frame, bound to the open file through Orca's document session, in Orca's theme and font.
import type { Language } from '../../src/protocol.ts';
import { modelView } from './model-view.ts';
import { monaco } from './monaco.ts';
import { showNote } from './notes.ts';
import { bindDocument, flushWhenHidden } from './sync.ts';
import { defineThemes, THEME_NAME, typographyOptions } from './theme.ts';

interface EditorContext {
  monaco: typeof monaco;
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  docId: string;
  language: Language;
}

const CONFLICT_NOTE =
  'An outside change overlapped your unsaved edits. Both versions are in the file between <<<<<<< and >>>>>>> markers.';

/** What Orca sets on its own file editor (MonacoEditor.tsx in the Orca repository). */
const NATIVE_OPTIONS = {
  automaticLayout: true,
  cursorSmoothCaretAnimation: 'off' as const,
  dropIntoEditor: { enabled: false },
  find: {
    addExtraSpaceOnTop: false,
    autoFindInSelection: 'never' as const,
    seedSearchStringFromSelection: 'selection' as const,
  },
  lineNumbers: 'on' as const,
  padding: { top: 0 },
  renderLineHighlight: 'line' as const,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  tabSize: 2,
};

const themeName = (): string =>
  document.documentElement.classList.contains('dark') ? THEME_NAME.dark : THEME_NAME.light;

async function startEditor(): Promise<EditorContext> {
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) {
    throw new Error('the page has no #root element');
  }
  const language: Language = window.__PHPANTOM_LANGUAGE__ === 'blade' ? 'blade' : 'php';
  const docId = crypto.randomUUID();
  const model = monaco.editor.createModel(
    '',
    language,
    monaco.Uri.parse(`inmemory://phpantom/${docId}.${language}`)
  );

  // Set once the editor exists, so an outside write's undo step restores the person's selection.
  let created: monaco.editor.IStandaloneCodeEditor | null = null;
  const view = modelView({
    getEol: () => (model.getEOL() === '\r\n' ? '\r\n' : '\n'),
    getText: () => model.getValue(),
    onDidChangeContent: (listener) => model.onDidChangeContent(listener),
    pushStackElement: () => {
      model.pushStackElement();
    },
    replace(start, end, text) {
      const range = monaco.Range.fromPositions(
        model.getPositionAt(start),
        model.getPositionAt(end)
      );
      // Why: an edit operation, not setValue, so the person's cursor and undo history survive.
      model.pushEditOperations(created?.getSelections() ?? null, [{ range, text }], () => null);
    },
    setEol: (eol) => {
      model.pushEOL(
        eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
      );
    },
    // Why setValue for the first text: it starts the undo history, so Cmd+Z never empties the file.
    setText: (text) => {
      model.setValue(text);
    },
  });
  const doc = await bindDocument(view, {
    onConflicts: () => {
      showNote('warning', CONFLICT_NOTE, 'conflict');
    },
  });
  view.load(doc.initial);
  flushWhenHidden(doc.flush, window, document);

  defineThemes(monaco);
  const typography = await orca.host.call('editor.readTypography', {}).catch((error: unknown) => {
    console.warn('editor.readTypography failed; using Monaco defaults', error);
    return null;
  });
  const editor = monaco.editor.create(root, {
    model,
    'readOnly': doc.readOnly,
    'semanticHighlighting.enabled': true,
    'theme': themeName(),
    ...NATIVE_OPTIONS,
    'fixedOverflowWidgets': true,
    'quickSuggestions': true,
    ...(typography ? typographyOptions(typography) : {}),
  });
  created = editor;
  orca.on('editor.typography.changed', (next) => {
    editor.updateOptions(typographyOptions(next));
  });
  // Orca has already switched the `--orca-*` variables and the `dark` class when this fires.
  orca.on('theme', () => {
    defineThemes(monaco);
    monaco.editor.setTheme(themeName());
  });
  editor.focus();
  return { docId, editor, language, model, monaco };
}

export { startEditor };
export type { EditorContext };
