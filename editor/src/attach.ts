// The Monaco and Orca side of the bridge: the model as a DocumentSource, Orca's frame API as a
// BridgeHost, and what the person sees (markers, reveals, notes) from what the worker says.
import type { PluginRequestArgs } from 'orca'
import type { AttachStatus } from '../../src/protocol.ts'
import { LspBridge, type BridgeHost, type DocumentSource, type WorkspaceContext } from './bridge.ts'
import type { EditorContext } from './editor.ts'
import { fromLspRange, toLspContentChange, toMarker, type LspDiagnostic } from './lsp-convert.ts'
import { clearNote, showNote } from './notes.ts'

const NOTE = 'phpantom-attach'

function context(value: { workspaceId?: string; branch: string; displayName: string } | null): WorkspaceContext | null {
  return value ? { workspaceId: value.workspaceId ?? null, branch: value.branch, displayName: value.displayName } : null
}

function frameHost(): BridgeHost {
  return {
    request: (name, input, options) =>
      // Why the cast: the declared overload takes its arguments as a tuple.
      orca.plugin.request(name, ...([input, options] as unknown as PluginRequestArgs<typeof name>)),
    on: (event, handler) => orca.plugin.on(event as 'phpantom.diagnostics', handler),
    readContext: async () => context(await orca.host.call('workspace.readContext', {})),
    // `orca.on` subscribes through `events.subscribe` itself, and a new subscriber hears the current context first.
    onWorkspaceChanged: (listener) => orca.on('workspace.changed', (payload) => listener(context(payload.context))),
    onFirstInput(listener) {
      // Capture on window: Monaco stops some events, and editor.focus() at start is not input.
      const handler = (): void => listener()
      window.addEventListener('pointerdown', handler, true)
      window.addEventListener('keydown', handler, true)
      return {
        dispose() {
          window.removeEventListener('pointerdown', handler, true)
          window.removeEventListener('keydown', handler, true)
        }
      }
    },
    onVisible(listener) {
      const handler = (): void => {
        if (document.visibilityState === 'visible') listener()
      }
      document.addEventListener('visibilitychange', handler)
      return { dispose: () => document.removeEventListener('visibilitychange', handler) }
    }
  }
}

function modelSource(ctx: EditorContext): DocumentSource {
  const { model, language } = ctx
  return {
    language,
    // The model's own text, not the BOM-keeping one Orca saves: Monaco's change positions are against it.
    getText: () => model.getValue(),
    getLength: () => model.getValueLength(),
    getVersion: () => model.getVersionId(),
    onChanges: (listener) =>
      model.onDidChangeContent((event) =>
        listener(
          event.changes.map((change) => ({ ...toLspContentChange(change), rangeLength: change.rangeLength })),
          // A line-ending switch rewrites every line: send it whole, as setValue.
          event.isFlush || event.isEolChange
        )
      )
  }
}

function showStatus(status: AttachStatus): void {
  switch (status.state) {
    case 'ready':
      clearNote(NOTE)
      return
    case 'single-file':
      showNote('info', "PHPantom couldn't tell which file this is, so only highlighting is on. It will try again after you save.", NOTE)
      return
    case 'remote':
      showNote('info', `This file is on ${status.host}. PHPantom runs on this computer only, so only highlighting is on.`, NOTE)
      return
    case 'error':
      showNote('warning', status.message, NOTE)
      return
    default:
      return
  }
}

export function attachLanguageServer(ctx: EditorContext): LspBridge {
  const { monaco, editor, model, docId } = ctx
  const bridge = new LspBridge(frameHost(), modelSource(ctx), { docId })
  bridge.onDiagnostics((diagnostics) => {
    monaco.editor.setModelMarkers(model, 'phpantom', (diagnostics as LspDiagnostic[]).map(toMarker))
  })
  bridge.onReveal((range) => {
    const target = fromLspRange(range)
    editor.setSelection(target)
    editor.revealRangeInCenter(target)
  })
  bridge.onStatus((status) => {
    if (status.state !== 'ready') {
      monaco.editor.setModelMarkers(model, 'phpantom', [])
    }
    showStatus(status)
  })
  window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
  bridge.attach().catch((error: unknown) => console.error('PHPantom attach failed', error))
  return bridge
}
