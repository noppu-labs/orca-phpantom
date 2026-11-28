import { sameUri } from '../../src/utils/uri.ts';
// Going to code in other files.
// Monaco shows only models it has, so the files a result points at get read-only models for its previews (peek, Cmd-hover), and opening one goes to the worker, which opens the file in an Orca tab.
// The pure parts here take no Monaco, so Node can test them.
import type { LspBridge } from './bridge.ts';
import type { EditorContext } from './editor.ts';
import { toLspRange, type MonacoRange } from './lsp-convert.ts';
import { showNote } from './notes.ts';

interface Disposable {
  dispose: () => void;
}
interface Location {
  uri: string;
  range: MonacoRange;
}

const NAVIGATION_NOTE = 'phpantom-navigation';

/** Results in the open document point at the editor's model; the rest keep their `file:` URIs. */
function mapLocations(locations: Location[], documentUri: string, modelUri: string): Location[] {
  return locations.map((location) =>
    sameUri(location.uri, documentUri) ? { ...location, uri: modelUri } : location
  );
}

/**
 * After a peek: the locations to show, and how many were left out because their file was asked for and
 * not read. `keepUnread` keeps them all: a definition is gone to through the opener, which needs no preview.
 */
function afterPeek(
  locations: Location[],
  asked: string[],
  read: string[],
  keepUnread: boolean
): { shown: Location[]; left: number } {
  if (keepUnread) return { left: 0, shown: locations };
  const got = new Set(read);
  const missing = new Set(asked.filter((uri) => !got.has(uri)));
  const shown = locations.filter((location) => !missing.has(location.uri));
  return { left: locations.length - shown.length, shown };
}

// The worker reads at most this many files per peek (PEEK_MAX_FILES in src/controllers/router.ts); asking for more only makes the request bigger, and a long list of URIs could pass Orca's 64 KiB request limit.
const PEEK_MAX_FILES = 25;

/** The files one peek asks for. Pass the whole list to `afterPeek`, so locations in the rest are left out with a note. */
const peekBatch = (wanted: string[]): string[] => wanted.slice(0, PEEK_MAX_FILES);

const moreResultsNote = (count: number): string =>
  count === 1
    ? '1 more result is in a file not shown here.'
    : `${count} more results are in files not shown here.`;

const cutResultsNote = (shown: number, cut: number): string =>
  `Showing the first ${shown} ${shown === 1 ? 'result' : 'results'}; ${cut} more ${cut === 1 ? 'was' : 'were'} cut.`;

/** The note for a query whose list was cut: counts what is shown, and is null (clear the note) when nothing was cut. */
const cutNoteFor = (shown: number, cut: number): string | null =>
  cut > 0 ? cutResultsNote(shown, cut) : null;

/** The models made for previews, at most `limit` of them; the least recently used goes first. */
class PeekModels {
  private readonly create: (uri: string, text: string) => Disposable;
  private readonly limit: number;
  /** In use order, oldest first. */
  private readonly models = new Map<string, Disposable>();

  public constructor(create: (uri: string, text: string) => Disposable, limit = 30) {
    this.create = create;
    this.limit = limit;
  }

  public ensure(files: { uri: string; text: string }[]): void {
    for (const file of files) {
      if (this.models.has(file.uri)) {
        this.touch([file.uri]);
        continue;
      }
      this.models.set(file.uri, this.create(file.uri, file.text));
    }
    for (const [uri, model] of this.models) {
      if (this.models.size <= this.limit) break;
      this.models.delete(uri);
      model.dispose();
    }
  }

  /** Marks models an answer uses again as recent, so making the others does not drop them. */
  public touch(uris: string[]): void {
    for (const uri of uris) {
      const model = this.models.get(uri);
      if (!model) continue;
      this.models.delete(uri);
      this.models.set(uri, model);
    }
  }

  public has(uri: string): boolean {
    return this.models.has(uri);
  }

  public dispose(): void {
    const models = [...this.models.values()];
    this.models.clear();
    for (const model of models) model.dispose();
  }
}

const NAVIGATE_NOTES = {
  'failed': "PHPantom couldn't open that file.",
  'not-a-file': "That definition is in PHP's built-in stubs, which have no file to open.",
  'outside-workspace': 'That definition is outside your open workspaces.',
} as const;

/**
 * Opens what Monaco would open in another editor (go to definition, a reference picked in the peek
 * list) as an Orca tab instead; the tab gets its reveal when it attaches. The model's own URI is left
 * to Monaco, which moves the cursor in this editor.
 */
function installOpener(ctx: EditorContext, bridge: LspBridge): Disposable {
  const { monaco, model } = ctx;
  return monaco.editor.registerEditorOpener({
    async openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.toString() === model.uri.toString()) return false;
      const range = selectionOrPosition
        ? 'startLineNumber' in selectionOrPosition
          ? selectionOrPosition
          : {
              endColumn: selectionOrPosition.column,
              endLineNumber: selectionOrPosition.lineNumber,
              startColumn: selectionOrPosition.column,
              startLineNumber: selectionOrPosition.lineNumber,
            }
        : { endColumn: 1, endLineNumber: 1, startColumn: 1, startLineNumber: 1 };
      const answer = await bridge.navigate(resource.toString(), toLspRange(range));
      if (!answer) return false;
      if (!answer.opened) showNote('info', NAVIGATE_NOTES[answer.reason], NAVIGATION_NOTE);
      return true;
    },
  });
}

export {
  NAVIGATION_NOTE,
  mapLocations,
  afterPeek,
  peekBatch,
  moreResultsNote,
  cutResultsNote,
  cutNoteFor,
  PeekModels,
  installOpener,
};
