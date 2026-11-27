// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// PHPantom's diagnostics for this editor, kept as sent and shown as markers.
import type { LspBridge } from '../bridge.ts';
import type { EditorContext } from '../editor.ts';
import { toMarker, type LspDiagnostic } from '../lsp-convert.ts';
import { disposeAll, type Disposable, type Model } from './shared.ts';

const MARKER_OWNER = 'phpantom';

const diagnosticsByModel = new WeakMap<Model, LspDiagnostic[]>();

/** The diagnostics PHPantom last published for `model`, as it sent them; code actions send them back. */
function diagnosticsOf(model: Model): LspDiagnostic[] {
  return diagnosticsByModel.get(model) ?? [];
}

/**
 * Keeps PHPantom's diagnostics for this editor and shows them as markers. Call it before attaching:
 * PHPantom publishes while the open is still answering, before any provider is registered.
 */
function showDiagnostics(ctx: EditorContext, bridge: LspBridge): Disposable {
  const set = (diagnostics: LspDiagnostic[]): void => {
    diagnosticsByModel.set(ctx.model, diagnostics);
    ctx.monaco.editor.setModelMarkers(ctx.model, MARKER_OWNER, diagnostics.map(toMarker));
  };
  return disposeAll([
    bridge.onDiagnostics((diagnostics) => {
      set(diagnostics as LspDiagnostic[]);
    }),
    bridge.onStatus((status) => {
      if (status.state !== 'ready') set([]);
    }),
  ]);
}

export { diagnosticsOf, showDiagnostics };
