// Adapted from actus7/orca-autocomplete editor/src/main.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// Monaco in Orca's frame, bound to the open file through Orca's document session, in Orca's theme and font.
import type { Language } from '../../src/protocol.ts'
import { monaco } from './monaco.ts'
import { showNote } from './notes.ts'
import { modelView } from './model-view.ts'
import { bindDocument } from './sync.ts'
import { defineThemes, THEME_NAME, typographyOptions } from './theme.ts'

export type EditorContext = {
  monaco: typeof monaco
  editor: monaco.editor.IStandaloneCodeEditor
  model: monaco.editor.ITextModel
  docId: string
  language: Language
}

const CONFLICT_NOTE =
  'An outside change overlapped your unsaved edits. Both versions are in the file between <<<<<<< and >>>>>>> markers.'

/** What Orca sets on its own file editor (MonacoEditor.tsx in the Orca repository). */
const NATIVE_OPTIONS = {
  dropIntoEditor: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbers: 'on' as const,
  renderLineHighlight: 'line' as const,
  automaticLayout: true,
  tabSize: 2,
  smoothScrolling: true,
  cursorSmoothCaretAnimation: 'off' as const,
  padding: { top: 0 },
  find: {
    addExtraSpaceOnTop: false,
    autoFindInSelection: 'never' as const,
    seedSearchStringFromSelection: 'selection' as const
  }
}

const themeName = (): string =>
  document.documentElement.classList.contains('dark') ? THEME_NAME.dark : THEME_NAME.light

export async function startEditor(): Promise<EditorContext> {
  const root = document.getElementById('root')
  if (!root) {
    throw new Error('the page has no #root element')
  }
  const language: Language = window.__PHPANTOM_LANGUAGE__ === 'blade' ? 'blade' : 'php'
  const docId = crypto.randomUUID()
  const model = monaco.editor.createModel('', language, monaco.Uri.parse(`inmemory://phpantom/${docId}.${language}`))

  // Set once the editor exists, so an outside write's undo step restores the person's selection.
  let created: monaco.editor.IStandaloneCodeEditor | null = null
  const view = modelView({
    getText: () => model.getValue(),
    getEol: () => (model.getEOL() === '\r\n' ? '\r\n' : '\n'),
    // Why setValue for the first text: it starts the undo history, so Cmd+Z never empties the file.
    setText: (text) => model.setValue(text),
    setEol: (eol) =>
      model.pushEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF),
    replace(start, end, text) {
      const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end))
      // Why: an edit operation, not setValue, so the person's cursor and undo history survive.
      model.pushEditOperations(created?.getSelections() ?? null, [{ range, text }], () => null)
    },
    pushStackElement: () => model.pushStackElement(),
    onDidChangeContent: (listener) => model.onDidChangeContent(listener)
  })
  const doc = await bindDocument(view, {
    onConflicts: () => showNote('warning', CONFLICT_NOTE, 'conflict')
  })
  view.load(doc.initial)

  defineThemes(monaco)
  const typography = await orca.host.call('editor.readTypography', {}).catch((error: unknown) => {
    console.warn('editor.readTypography failed; using Monaco defaults', error)
    return null
  })
  const editor = monaco.editor.create(root, {
    model,
    theme: themeName(),
    readOnly: doc.readOnly,
    'semanticHighlighting.enabled': true,
    ...NATIVE_OPTIONS,
    quickSuggestions: true,
    fixedOverflowWidgets: true,
    ...(typography ? typographyOptions(typography) : {})
  })
  created = editor
  orca.on('editor.typography.changed', (next) => editor.updateOptions(typographyOptions(next)))
  // Orca has already switched the `--orca-*` variables and the `dark` class when this fires.
  orca.on('theme', () => {
    defineThemes(monaco)
    monaco.editor.setTheme(themeName())
  })
  editor.focus()
  return { monaco, editor, model, docId, language }
}
