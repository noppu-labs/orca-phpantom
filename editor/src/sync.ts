import { smallestEdit, type Splice } from './edits.ts';
import { mergeText } from './merge.ts';

interface TextView {
  getValue: () => string;
  applyOutside: (splice: Splice) => void;
  onUserChange: (listener: () => void) => { dispose: () => void };
}

/** Keeps `view` and the Orca document in sync; resolves once the first document is in. */
async function bindDocument(
  view: TextView,
  options: { onConflicts?: (count: number) => void } = {}
): Promise<{ readOnly: boolean; initial: string; flush: () => void; dispose: () => void }> {
  const api = globalThis.orca.document;
  if (!api) {
    throw new Error('orca.document is only available in custom editors');
  }
  const session = await api.session({
    merge: (base, outside, mine) => {
      const merged = mergeText(base, outside, mine);
      if (merged.conflicts > 0) {
        options.onConflicts?.(merged.conflicts);
      }
      return merged.text;
    },
  });
  let applying = false;
  const replaced = session.onReplace((value) => {
    const splice = smallestEdit(view.getValue(), value);
    if (!splice) {
      return;
    }
    applying = true;
    try {
      view.applyOutside(splice);
    } finally {
      applying = false;
    }
  });
  const changes = view.onUserChange(() => {
    if (!applying) {
      session.change(view.getValue());
    }
  });
  return {
    readOnly: session.readOnly,
    initial: session.value,
    /** Sends a pending edit now instead of after Orca's debounce. Fire and forget: it never throws or waits. */
    flush() {
      try {
        session.flush().catch(() => {});
      } catch {
        // A session already gone has nothing to send.
      }
    },
    dispose() {
      changes.dispose();
      replaced.dispose();
      session.dispose();
    },
  };
}

type VisibilityTarget = EventTarget & { readonly visibilityState: DocumentVisibilityState };

/**
 * Calls `flush` when the page hides or goes away. Why: Orca may tear the frame down on a tab switch, and an
 * edit still inside the session's debounce (250 ms) would never reach Orca.
 */
function flushWhenHidden(
  flush: () => void,
  win: EventTarget,
  page: VisibilityTarget
): { dispose: () => void } {
  const run = (): void => {
    try {
      flush();
    } catch {
      // Never in the way of the page going away.
    }
  };
  const onVisibility = (): void => {
    if (page.visibilityState === 'hidden') run();
  };
  win.addEventListener('pagehide', run);
  page.addEventListener('visibilitychange', onVisibility);
  return {
    dispose() {
      win.removeEventListener('pagehide', run);
      page.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

export { bindDocument, flushWhenHidden };
export type { TextView };
