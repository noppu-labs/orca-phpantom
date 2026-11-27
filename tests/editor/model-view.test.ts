import { assert, mockEditorHost, test } from 'orca/testing';

import { smallestEdit } from '../../editor/src/edits.ts';
import { modelView, type Eol, type ModelPort } from '../../editor/src/model-view.ts';
import { bindDocument } from '../../editor/src/sync.ts';

// A stand-in for Monaco's text model with the rules that matter here, copied from monaco-editor 0.57.0:
// - setValue strips a UTF-8 BOM and picks the EOL most lines use, then rewrites every line ending to it
//   (pieceTreeTextBufferBuilder.js `_getEOL`, `create`);
// - an inserted text whose line endings are not all the buffer's kind (other kind, mixed, or a lone
//   `\r`) is rewritten to the buffer's EOL (pieceTreeTextBuffer.js applyEdits, eolCounter.js);
// - pushEOL rewrites every line ending.
function fakeMonacoModel() {
  let text = '';
  let eol: Eol = '\n';
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const changed = (): void => listeners.forEach((l) => l());
  const kind = (s: string): 'none' | Eol | 'invalid' => {
    const lf = /(?<!\r)\n/.test(s);
    const crlf = s.includes('\r\n');
    const cr = /\r(?!\n)/.test(s);
    if (cr || (lf && crlf)) return 'invalid';
    return lf ? '\n' : crlf ? '\r\n' : 'none';
  };
  const port: ModelPort = {
    getText: () => text,
    getEol: () => eol,
    setText(value) {
      const body = value.startsWith('﻿') ? value.slice(1) : value;
      const crlf = (body.match(/\r\n/g) ?? []).length;
      const cr = (body.match(/\r(?!\n)/g) ?? []).length;
      const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
      const total = crlf + cr + lf;
      eol = total === 0 ? '\n' : cr + crlf > total / 2 ? '\r\n' : '\n';
      text = body.replaceAll(/\r\n|\r|\n/g, eol);
      calls.push('setText');
      changed();
    },
    setEol(next) {
      calls.push(`setEol:${JSON.stringify(next)}`);
      if (next !== eol) {
        eol = next;
        text = text.replaceAll(/\r\n|\r|\n/g, eol);
        changed();
      }
    },
    replace(start, end, inserted) {
      calls.push('replace');
      const k = kind(inserted);
      const valid = k === 'none' || k === eol ? inserted : inserted.replaceAll(/\r\n|\r|\n/g, eol);
      text = text.slice(0, start) + valid + text.slice(end);
      changed();
    },
    pushStackElement: () => calls.push('stack'),
    onDidChangeContent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    port,
    calls,
    type(next: string) {
      text = next;
      changed();
    },
  };
}

function outsideWrite(model: string, outside: string) {
  const fake = fakeMonacoModel();
  const view = modelView(fake.port);
  view.load(model);
  const splice = smallestEdit(view.getValue(), outside);
  if (splice) view.applyOutside(splice);
  return { fake, view };
}

test('the fake reproduces the corruption a raw splice causes', () => {
  const fake = fakeMonacoModel();
  fake.port.setText('a\nb\nc');
  const splice = smallestEdit('a\nb\nc', 'a\r\nb\r\nc')!;
  fake.port.replace(splice.start, splice.end, splice.text);
  assert.equal(fake.port.getText(), 'a\nb\n\nc');
});
test('an outside write that switches LF to CRLF lands exactly', () => {
  assert.equal(outsideWrite('a\nb\nc', 'a\r\nb\r\nc').view.getValue(), 'a\r\nb\r\nc');
  assert.equal(outsideWrite('x\ny', 'x\r\nz\r\ny').view.getValue(), 'x\r\nz\r\ny');
  assert.equal(outsideWrite('a\r\nb', 'a\nb\nc\n').view.getValue(), 'a\nb\nc\n');
});
test('mixed line endings unify the way Monaco would and never add lines', () => {
  const { view } = outsideWrite('a\nb\nc', 'a\r\nb\nc\r\nd\re');
  assert.equal(view.getValue(), 'a\r\nb\r\nc\r\nd\r\ne');
});
test('an outside write is its own undo step', () => {
  const { fake } = outsideWrite('a\nb\n', 'a\nB\n');
  const after = fake.calls.slice(fake.calls.indexOf('setText') + 1);
  assert.equal(after[0], 'stack');
  assert.equal(after.at(-1), 'stack');
  assert.ok(after.includes('replace'));
});
test('a line-ending switch is an undo step of its own, before the text edit', () => {
  // Monaco records an edit's offsets against the buffer after the switch, but redo replays them on the buffer before it (textModel.js _applyRedo), so the two must not share an undo step.
  const { fake } = outsideWrite('a\nb\nc', 'a\r\nb\r\nX');
  assert.deepEqual(fake.calls.slice(fake.calls.indexOf('setText') + 1), [
    'stack',
    String.raw`setEol:"\r\n"`,
    'stack',
    'replace',
    'stack',
  ]);
});
test('keeps a UTF-8 BOM through load, outside writes and typing', async () => {
  const host = mockEditorHost({ text: '﻿<?php\n' });
  const fake = fakeMonacoModel();
  const view = modelView(fake.port);
  const doc = await bindDocument(view);
  view.load(doc.initial);
  assert.equal(fake.port.getText(), '<?php\n');
  assert.equal(view.getValue(), '﻿<?php\n');
  fake.type('<?php\necho 1;\n');
  await host.flush();
  assert.equal(host.text, '﻿<?php\necho 1;\n');
  doc.dispose();
  host.dispose();
});
test('loading and outside writes are not sent back to Orca', async () => {
  const host = mockEditorHost({ text: 'a\nb\n' });
  const fake = fakeMonacoModel();
  const view = modelView(fake.port);
  const doc = await bindDocument(view);
  view.load(doc.initial);
  host.replace('a\r\nb\r\nc\r\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(view.getValue(), 'a\r\nb\r\nc\r\n');
  assert.equal(host.edits.length, 0);
  // The next keystroke sends only that keystroke: Orca's line endings are kept.
  fake.type('a\r\nb\r\nc\r\nd');
  await host.flush();
  assert.equal(host.text, 'a\r\nb\r\nc\r\nd');
  doc.dispose();
  host.dispose();
});
