// The Monaco side of the bridge: the model as a DocumentSource, and what the person sees (markers, reveals, notes, the language features) from what the worker says.
import type { AttachStatus } from '../../src/protocol.ts';
import { LspBridge, type DocumentSource } from './bridge.ts';
import type { EditorContext } from './editor.ts';
import { frameHost } from './frame-host.ts';
import { fromLspRange, toLspContentChange } from './lsp-convert.ts';
import { installOpener } from './navigation.ts';
import { clearNote, showNote } from './notes.ts';
import {
  registerEditingProviders,
  registerReadingProviders,
  showDiagnostics,
} from './providers.ts';

const NOTE = 'phpantom-attach';
const BUSY_NOTE = 'phpantom-busy';
const BUSY_TEXT =
  'Orca is limiting how often PHPantom can answer right now. Try again in a moment.';
const BUSY_NOTE_MS = 6000;

function modelSource(ctx: EditorContext): DocumentSource {
  const { model, language } = ctx;
  return {
    language,
    // The model's own text, not the BOM-keeping one Orca saves: Monaco's change positions are against it.
    getText: () => model.getValue(),
    getLength: () => model.getValueLength(),
    getVersion: () => model.getVersionId(),
    onChanges: (listener) =>
      model.onDidChangeContent((event) => {
        listener(
          event.changes.map((change) => ({
            ...toLspContentChange(change),
            rangeLength: change.rangeLength,
          })),
          // A line-ending switch rewrites every line: send it whole, as setValue.
          event.isFlush || event.isEolChange
        );
      }),
  };
}

function showStatus(status: AttachStatus): void {
  switch (status.state) {
    case 'ready': {
      clearNote(NOTE);
      return;
    }
    case 'single-file': {
      showNote(
        'info',
        "PHPantom couldn't tell which file this is, so only highlighting is on. It will try again after you save.",
        NOTE
      );
      return;
    }
    case 'remote': {
      showNote(
        'info',
        `This file is on ${status.host}. PHPantom runs on this computer only, so only highlighting is on.`,
        NOTE
      );
      return;
    }
    case 'error': {
      showNote('warning', status.message, NOTE);
      return;
    }
    default: {
      return;
    }
  }
}

function attachLanguageServer(ctx: EditorContext): LspBridge {
  const { editor, docId } = ctx;
  const bridge = new LspBridge(frameHost(), modelSource(ctx), { docId });
  showDiagnostics(ctx, bridge);
  // Registered anew on each attach: a new server can say it supports something else.
  const providers: { dispose(): void }[] = [];
  const unregister = (): void => {
    for (const registered of providers.splice(0)) registered.dispose();
  };
  bridge.onReady((status) => {
    unregister();
    // Each on its own: a failure in one set leaves the others working.
    const register = (what: string, run: () => { dispose(): void }): void => {
      try {
        providers.push(run());
      } catch (error) {
        console.error(`PHPantom ${what} failed to register`, error);
      }
    };
    register('language features', () => registerReadingProviders(ctx, bridge, status.capabilities));
    register('navigation and edits', () =>
      registerEditingProviders(ctx, bridge, status.capabilities)
    );
    register('editor opener', () => installOpener(ctx, bridge));
  });
  // Only for something the person asked for: passive requests Orca holds back are dropped quietly.
  let busyTimer: ReturnType<typeof setTimeout> | undefined;
  bridge.onBusy(() => {
    showNote('info', BUSY_TEXT, BUSY_NOTE);
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => {
      clearNote(BUSY_NOTE);
    }, BUSY_NOTE_MS);
  });
  bridge.onReveal((range) => {
    const target = fromLspRange(range);
    editor.setSelection(target);
    editor.revealRangeInCenter(target);
  });
  bridge.onStatus((status) => {
    // Why unregister: colouring from a server that no longer has this document would stay on screen.
    if (status.state !== 'ready') unregister();
    showStatus(status);
  });
  window.addEventListener(
    'pagehide',
    () => {
      bridge.dispose();
    },
    { once: true }
  );
  bridge.attach().catch((error: unknown) => {
    console.error('PHPantom attach failed', error);
  });
  return bridge;
}

export { attachLanguageServer };
