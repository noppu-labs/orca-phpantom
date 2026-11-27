// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// PHPantom's diagnostics for this editor, kept as sent and shown as markers.
import type { LspBridge } from '../bridge.ts';
import type { EditorContext } from '../editor.ts';
import { isDiagnosticList, toMarker, type LspDiagnostic } from '../lsp-convert.ts';
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
    const markers = diagnostics.map((diagnostic) => toMarker(diagnostic));
    // oxlint-disable-next-line typescript/no-unsafe-enum-assignment -- toMarker has already turned LSP's severities into Monaco's numbers, and both number tags the same way
    ctx.monaco.editor.setModelMarkers(ctx.model, MARKER_OWNER, markers);
  };
  return disposeAll([
    bridge.onDiagnostics((diagnostics) => {
      // Why skip: a list with something other than an object in it cannot be shown as markers.
      if (isDiagnosticList(diagnostics)) set(diagnostics);
    }),
    bridge.onStatus((status) => {
      if (status.state !== 'ready') set([]);
    }),
  ]);
}

export { diagnosticsOf, showDiagnostics };
