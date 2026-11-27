import { CARRIAGE_RETURN, LINE_FEED } from '../../constants/characters.ts';
import type { LspContentChange, LspPosition } from '../../protocol.ts';

/**
 * The worker's copy of an open document. Offsets are UTF-16 code units; `\r\n`, `\r` and `\n` each end a line.
 * apply() costs one scan of the text up to the change (no cached line index) plus one string splice, so a change
 * is O(document length) with a very small constant (~1 ms at 1 MB).
 */
class DocumentMirror {
  private content: string;
  public version = 0;

  public constructor(text: string) {
    this.content = text;
  }

  public get text(): string {
    return this.content;
  }

  public get length(): number {
    return this.content.length;
  }

  public apply(changes: LspContentChange[]): void {
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
    let start = 0;
    if (fromPos && fromPos.line <= pos.line) {
      ({ line } = fromPos);
      start = this.lineStart(from);
    }
    while (line < pos.line) {
      const next = this.nextLineStart(start);
      if (next < 0) return text.length;
      start = next;
      line++;
    }
    let lineEnd = start;
    while (lineEnd < text.length) {
      const code = text.charCodeAt(lineEnd);
      if (code === LINE_FEED || code === CARRIAGE_RETURN) break;
      lineEnd++;
    }
    return Math.min(start + Math.max(pos.character, 0), lineEnd);
  }

  private lineStart(offset: number): number {
    const text = this.content;
    let start = offset;
    while (start > 0) {
      const code = text.charCodeAt(start - 1);
      if (code === LINE_FEED || code === CARRIAGE_RETURN) break;
      start--;
    }
    return start;
  }

  private nextLineStart(from: number): number {
    const text = this.content;
    for (let index = from; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === LINE_FEED) return index + 1;
      if (code === CARRIAGE_RETURN) {
        return text.charCodeAt(index + 1) === LINE_FEED ? index + 2 : index + 1;
      }
    }
    return -1;
  }
}

export { DocumentMirror };
