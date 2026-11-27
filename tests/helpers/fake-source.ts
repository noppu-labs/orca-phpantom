import type { DocumentSource, SourceChange } from '../../editor/src/bridge.ts';
// A DocumentSource over a plain string, reporting edits the way Monaco does, for bridge tests.
import type { Language, LspPosition } from '../../src/protocol.ts';

export type FakeSource = DocumentSource & {
  readonly text: string;
  /** One edit, in offsets of the current text. */
  edit(start: number, end: number, insert: string): void;
  /** One event with several edits (multi-cursor), each in offsets of the text before the event. */
  editMany(edits: [number, number, string][]): void;
  replaceAll(text: string): void;
};

export function source(initial: string, language: Language = 'php'): FakeSource {
  let value = initial;
  let version = 1;
  const listeners = new Set<(changes: SourceChange[], isFlush: boolean) => void>();
  const positionAt = (text: string, offset: number): LspPosition => {
    const before = text.slice(0, offset);
    const line = before.split('\n').length - 1;
    return { line, character: offset - (before.lastIndexOf('\n') + 1) };
  };
  const emit = (changes: SourceChange[], isFlush: boolean) => {
    version += 1;
    for (const listener of [...listeners]) listener(changes, isFlush);
  };
  return {
    language,
    get text() {
      return value;
    },
    getText: () => value,
    getLength: () => value.length,
    getVersion: () => version,
    onChanges(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    edit(start, end, insert) {
      const range = { start: positionAt(value, start), end: positionAt(value, end) };
      value = value.slice(0, start) + insert + value.slice(end);
      emit([{ range, rangeLength: end - start, text: insert }], false);
    },
    editMany(edits) {
      const before = value;
      // As Monaco reports them: from the end of the document to the start, each against the old text.
      const sorted = [...edits].sort((a, b) => b[0] - a[0]);
      const changes = sorted.map(([start, end, text]) => ({
        range: { start: positionAt(before, start), end: positionAt(before, end) },
        rangeLength: end - start,
        text,
      }));
      for (const [start, end, text] of sorted) {
        value = value.slice(0, start) + text + value.slice(end);
      }
      emit(changes, false);
    },
    replaceAll(text) {
      const range = { start: { line: 0, character: 0 }, end: positionAt(value, value.length) };
      const rangeLength = value.length;
      value = text;
      emit([{ range, rangeLength, text }], true);
    },
  };
}
