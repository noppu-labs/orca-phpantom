import { assert, test, mockEditorHost } from 'orca/testing';

import { bindDocument, flushWhenHidden, type TextView } from '../../editor/src/sync.ts';

function fakeView(initial = ''): TextView & { type(text: string): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getValue: () => value,
    applyOutside: (s) => {
      value = value.slice(0, s.start) + s.text + value.slice(s.end);
      // Monaco reports programmatic edits as content changes too; the binding must not echo them.
      for (const l of listeners) l();
    },
    onUserChange(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    type(text) {
      value = text;
      for (const l of listeners) l();
    },
  };
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

test('sends a user edit and saves it', async () => {
  const host = mockEditorHost({ text: '<?php\n' });
  const view = fakeView();
  const doc = await bindDocument(view);
  view.type('<?php\necho 1;\n');
  await host.flush();
  assert.equal(host.text, '<?php\necho 1;\n');
  doc.dispose();
  host.dispose();
});
test('applies an outside write without echoing it back', async () => {
  const host = mockEditorHost({ text: 'a\n' });
  const view = fakeView();
  await bindDocument(view);
  host.replace('a\nb\n');
  await settle();
  assert.equal(view.getValue(), 'a\nb\n');
  assert.equal(host.edits.length, 0);
  host.dispose();
});
test('keeps the draft when an agent writes during unsaved edits', async () => {
  const host = mockEditorHost({ text: 'a\nb\nc\n' });
  const view = fakeView();
  let conflicts = 0;
  await bindDocument(view, { onConflicts: (n) => (conflicts = n) });
  view.type('a\nB1\nc\n');
  host.conflictNext('a\nB2\nc\n');
  await host.flush();
  assert.equal(
    host.text,
    'a\n<<<<<<< your unsaved edits\nB1\n=======\nB2\n>>>>>>> file on disk\nc\n'
  );
  assert.equal(conflicts, 1);
  host.dispose();
});
test('reports read-only documents', async () => {
  const host = mockEditorHost({ text: 'x' }, { readOnly: true });
  assert.equal((await bindDocument(fakeView())).readOnly, true);
  host.dispose();
});
test('flush sends a pending edit before the debounce would', async () => {
  const host = mockEditorHost({ text: '<?php\n' });
  const view = fakeView();
  const doc = await bindDocument(view);
  view.type('<?php\necho 1;\n');
  assert.equal(doc.flush(), undefined);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(host.text, '<?php\necho 1;\n');
  doc.dispose();
  host.dispose();
});
test('flushes when the page hides or goes away, and never throws', async () => {
  const host = mockEditorHost({ text: 'a\n' });
  const view = fakeView();
  const doc = await bindDocument(view);
  const win = new EventTarget();
  const page = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  });
  const hooked = flushWhenHidden(doc.flush, win, page);
  view.type('a\nb\n');
  // Shown, not hidden: nothing is sent early.
  page.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(host.text, 'a\n');
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(host.text, 'a\nb\n');
  view.type('a\nb\nc\n');
  win.dispatchEvent(new Event('pagehide'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(host.text, 'a\nb\nc\n');
  hooked.dispose();
  const throwing = flushWhenHidden(
    () => {
      throw new Error('the frame is going away');
    },
    win,
    page
  );
  win.dispatchEvent(new Event('pagehide'));
  throwing.dispose();
  doc.dispose();
  host.dispose();
});
