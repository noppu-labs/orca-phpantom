import { assert, test } from 'orca/testing'
import { mockEditorHost } from 'orca/testing'
import { bindDocument, type TextView } from './sync.ts'

function fakeView(initial = ''): TextView & { type(text: string): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getValue: () => value,
    applyOutside: (s) => {
      value = value.slice(0, s.start) + s.text + value.slice(s.end)
      // Monaco reports programmatic edits as content changes too; the binding must not echo them.
      for (const l of listeners) l()
    },
    onUserChange(listener) {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    type(text) {
      value = text
      for (const l of listeners) l()
    }
  }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

test('sends a user edit and saves it', async () => {
  const host = mockEditorHost({ text: '<?php\n' })
  const view = fakeView()
  const doc = await bindDocument(view)
  view.type('<?php\necho 1;\n')
  await host.flush()
  assert.equal(host.text, '<?php\necho 1;\n')
  doc.dispose(); host.dispose()
})
test('applies an outside write without echoing it back', async () => {
  const host = mockEditorHost({ text: 'a\n' })
  const view = fakeView()
  await bindDocument(view)
  host.replace('a\nb\n')
  await settle()
  assert.equal(view.getValue(), 'a\nb\n')
  assert.equal(host.edits.length, 0)
  host.dispose()
})
test('keeps the draft when an agent writes during unsaved edits', async () => {
  const host = mockEditorHost({ text: 'a\nb\nc\n' })
  const view = fakeView()
  let conflicts = 0
  await bindDocument(view, { onConflicts: (n) => (conflicts = n) })
  view.type('a\nB1\nc\n')
  host.conflictNext('a\nB2\nc\n')
  await host.flush()
  assert.equal(host.text, 'a\n<<<<<<< your unsaved edits\nB1\n=======\nB2\n>>>>>>> file on disk\nc\n')
  assert.equal(conflicts, 1)
  host.dispose()
})
test('reports read-only documents', async () => {
  const host = mockEditorHost({ text: 'x' }, { readOnly: true })
  assert.equal((await bindDocument(fakeView())).readOnly, true)
  host.dispose()
})
