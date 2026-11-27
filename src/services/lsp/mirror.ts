import type { LspContentChange, LspPosition } from '../../protocol.ts';

/**
 * The worker's copy of an open document. Offsets are UTF-16 code units; `\r\n`, `\r` and `\n` each end a line.
 * apply() costs one scan of the text up to the change (no cached line index) plus one string splice, so a change
 * is O(document length) with a very small constant (~1 ms at 1 MB).
 */
class DocumentMirror {
  private content: string;
  version = 0;

  constructor(text: string) {
    this.content = text;
  }

  get text(): string {
    return this.content;
  }

  get length(): number {
    return this.content.length;
  }

  apply(changes: LspContentChange[]): void {
    for (const change of changes) {
      if (!('range' in change)) {
        this.content = change.text;
        continue;
      }
      const start = this.offsetAt(change.range.start);
      const end = Math.max(start, this.offsetAt(change.range.end, start, change.range.start));
      this.content = this.content.slice(0, start) + change.text + this.content.slice(end);
    }
  }

  /** Offset of a position; a character past the line's end clamps to the end of its content, a line past the end to the end of the text. */
  private offsetAt(pos: LspPosition, from = 0, fromPos?: LspPosition): number {
    const text = this.content;
    let line = 0;
    let i = 0;
    if (fromPos && fromPos.line <= pos.line) {
      ({ line } = fromPos);
      i = this.lineStart(from);
    }
    while (line < pos.line) {
      const next = this.nextLineStart(i);
      if (next < 0) return text.length;
      i = next;
      line++;
    }
    let lineEnd = i;
    while (lineEnd < text.length) {
      const c = text.charCodeAt(lineEnd);
      if (c === 0x0a || c === 0x0d) break;
      lineEnd++;
    }
    return Math.min(i + Math.max(pos.character, 0), lineEnd);
  }

  private lineStart(offset: number): number {
    const text = this.content;
    let i = offset;
    while (i > 0) {
      const c = text.charCodeAt(i - 1);
      if (c === 0x0a || c === 0x0d) break;
      i--;
    }
    return i;
  }

  private nextLineStart(from: number): number {
    const text = this.content;
    for (let i = from; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x0a) return i + 1;
      if (c === 0x0d) return text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
    }
    return -1;
  }
}

export { DocumentMirror };
