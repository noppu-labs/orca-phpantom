import { assert, mockEditorHost, test } from 'orca/testing';

import { frameHost } from '../../editor/src/frame-host.ts';
import { bindDocument, type TextView } from '../../editor/src/sync.ts';

function view(): TextView & { type: (text: string) => void } {
  let value = '';
  const listeners = new Set<() => void>();
  return {
    getValue: () => value,
    applyOutside: (s) => {
      value = value.slice(0, s.start) + s.text + value.slice(s.end);
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

test('hears a save without holding up the edits it saves', async () => {
  const host = mockEditorHost({ text: '<?php\n' });
  const text = view();
  const doc = await bindDocument(text);
  let saves = 0;
  const saved = frameHost().onSaved(() => (saves += 1));
  text.type('<?php\necho 1;\n');
  await host.flush();
  assert.equal(saves, 1);
  assert.equal(host.text, '<?php\necho 1;\n');
  saved.dispose();
  await host.flush();
  assert.equal(saves, 1);
  doc.dispose();
  host.dispose();
});
