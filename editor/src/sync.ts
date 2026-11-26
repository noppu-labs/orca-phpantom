import { mergeText } from './merge.ts'
import { smallestEdit, type Splice } from './edits.ts'

export type TextView = {
  getValue(): string
  applyOutside(splice: Splice): void
  onUserChange(listener: () => void): { dispose(): void }
}

/** Keeps `view` and the Orca document in sync; resolves once the first document is in. */
export async function bindDocument(
  view: TextView,
  options: { onConflicts?(count: number): void } = {}
): Promise<{ readOnly: boolean; initial: string; dispose(): void }> {
  const api = globalThis.orca.document
  if (!api) {
    throw new Error('orca.document is only available in custom editors')
  }
  const session = await api.session<string>({
    merge: (base, outside, mine) => {
      const merged = mergeText(base, outside, mine)
      if (merged.conflicts > 0) {
        options.onConflicts?.(merged.conflicts)
      }
      return merged.text
    }
  })
  let applying = false
  const replaced = session.onReplace((value) => {
    const splice = smallestEdit(view.getValue(), value)
    if (!splice) {
      return
    }
    applying = true
    try {
      view.applyOutside(splice)
    } finally {
      applying = false
    }
  })
  const changes = view.onUserChange(() => {
    if (!applying) {
      session.change(view.getValue())
    }
  })
  return {
    readOnly: session.readOnly,
    initial: session.value,
    dispose() {
      changes.dispose()
      replaced.dispose()
      session.dispose()
    }
  }
}
