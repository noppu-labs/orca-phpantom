// The editor <-> worker contract, declared once. Types only: the editor imports this file as
// `../../src/protocol.ts` and the worker reads the same declarations.
export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspContentChange = { range: LspRange; text: string } | { text: string };
export type Language = 'php' | 'blade';
export type AttachStatus =
  | {
      state: 'ready';
      session: string;
      uri: string;
      capabilities: Record<string, unknown>;
      approximate?: true;
      reveal?: LspRange;
    }
  | { state: 'pending' } // more chunks expected
  | { state: 'single-file'; reason: 'no-file' | 'ambiguous' }
  | { state: 'remote'; host: string }
  | { state: 'error'; message: string };
declare module 'orca' {
  interface PluginRequests {
    'phpantom.open': {
      input: {
        docId: string;
        language: Language;
        workspaceId: string | null;
        branch: string | null;
        displayName: string | null;
        index: number;
        chunk: string;
        last: boolean;
        resync?: true;
      };
      output: AttachStatus;
    };
    'phpantom.change': {
      input: {
        docId: string;
        session: string;
        version: number;
        changes: LspContentChange[];
        length: number;
      };
      output: { ok: true } | { detached: true } | { resync: true };
    };
    'phpantom.request': {
      input: { docId: string; session: string; method: string; params: Record<string, unknown> };
      output: { result: unknown; truncated?: number } | { detached: true } | { error: string };
    };
    'phpantom.close': { input: { docId: string }; output: { ok: true } };
    'phpantom.navigate': {
      input: { docId: string; session: string; uri: string; range: LspRange };
      output:
        | { opened: true }
        | { opened: false; reason: 'outside-workspace' | 'not-a-file' | 'failed' };
    };
    'phpantom.peek': {
      input: { docId: string; session: string; uris: string[] };
      output: { files: { uri: string; text: string }[]; omitted: number };
    };
    /** Renews the document's lease; the worker releases a document it has not heard from in three minutes. */
    'phpantom.ping': {
      input: { docId: string; session: string };
      output: { ok: true } | { detached: true };
    };
  }
  interface PluginPanelEvents {
    'phpantom.diagnostics': { docId: string; diagnostics: unknown[]; truncated: number };
    'phpantom.status': {
      docId: string;
      state: 'restarting' | 'stopped' | 'error';
      message?: string;
    };
    'phpantom.refresh': { kinds: ('semanticTokens' | 'inlayHints' | 'codeLens' | 'diagnostics')[] };
    'phpantom.reveal': { docId: string; range: LspRange };
  }
}
