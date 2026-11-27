// Adapted from actus7/orca-autocomplete editor/src/lsp-convert.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import type { LspContentChange } from '../../src/protocol.ts';
import { sameUri } from '../../src/utils/uri.ts';

// Conversions between the Language Server Protocol and Monaco. Pure data in, pure data out, so Node can test them: the Monaco-aware code only wraps these.

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

// LSP positions count from 0 and Monaco's from 1; both measure columns in UTF-16 code units.
export const toLspPosition = (position: { lineNumber: number; column: number }): LspPosition => ({
  line: position.lineNumber - 1,
  character: position.column - 1,
});

export const fromLspRange = (range: LspRange): MonacoRange => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1,
});

export const toLspRange = (range: MonacoRange): LspRange => ({
  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
});

/** One of Monaco's content changes as an LSP incremental change; Monaco's ranges are against the text before it. */
export const toLspContentChange = (change: {
  range: MonacoRange;
  text: string;
}): Extract<LspContentChange, { range: unknown }> => ({
  range: toLspRange(change.range),
  text: change.text,
});

/** LSP severity (1 error ... 4 hint) as Monaco's MarkerSeverity (8, 4, 2, 1). */
export function markerSeverity(severity: number | undefined): number {
  switch (severity) {
    case 2: {
      return 4;
    }
    case 3: {
      return 2;
    }
    case 4: {
      return 1;
    }
    default: {
      return 8;
    }
  }
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
  tags?: number[];
}

/** A diagnostic as a Monaco marker. Tags (unnecessary code, deprecated) use the same numbers in both. */
export function toMarker(diagnostic: LspDiagnostic) {
  const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
  return {
    ...fromLspRange(diagnostic.range),
    severity: markerSeverity(diagnostic.severity),
    message: diagnostic.message,
    ...(code === undefined ? {} : { code: String(code) }),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.tags?.length ? { tags: diagnostic.tags } : {}),
  };
}

const COMPLETION_KIND_NAMES: Record<number, string> = {
  1: 'Text',
  2: 'Method',
  3: 'Function',
  4: 'Constructor',
  5: 'Field',
  6: 'Variable',
  7: 'Class',
  8: 'Interface',
  9: 'Module',
  10: 'Property',
  11: 'Unit',
  12: 'Value',
  13: 'Enum',
  14: 'Keyword',
  15: 'Snippet',
  16: 'Color',
  17: 'File',
  18: 'Reference',
  19: 'Folder',
  20: 'EnumMember',
  21: 'Constant',
  22: 'Struct',
  23: 'Event',
  24: 'Operator',
  25: 'TypeParameter',
};

/** The name of Monaco's CompletionItemKind member for an LSP kind. */
export const completionKindName = (kind: number | undefined): string =>
  COMPLETION_KIND_NAMES[kind ?? 1] ?? 'Text';

type MarkedString = string | { language: string; value: string };
interface Markup {
  kind?: string;
  value: string;
}

/** Hover and documentation text of any LSP shape as Markdown. */
export function toMarkdown(
  contents: MarkedString | MarkedString[] | Markup | undefined | null
): string[] {
  if (contents === undefined || contents === null) {
    return [];
  }
  const items = Array.isArray(contents) ? contents : [contents];
  return items
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if ('language' in item) {
        return `\`\`\`${item.language}\n${item.value}\n\`\`\``;
      }
      return item.kind === 'plaintext' ? escapeMarkdown(item.value) : item.value;
    })
    .filter((text) => text.trim() !== '');
}

function escapeMarkdown(text: string): string {
  return text.replaceAll(/([\\`*_{}[\]()#+\-.!|>])/g, String.raw`\$1`);
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export const toMonacoEdit = (edit: LspTextEdit) => ({
  range: fromLspRange(edit.range),
  text: edit.newText,
});

export type LspLocation =
  | { uri: string; range: LspRange }
  | { targetUri: string; targetSelectionRange: LspRange; targetRange: LspRange };

/** Locations (or links) as plain {uri, range}, whichever shape the server used, or none. */
export function normalizeLocations(result: unknown): { uri: string; range: MonacoRange }[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return (list as LspLocation[]).map((item) =>
    'targetUri' in item
      ? { uri: item.targetUri, range: fromLspRange(item.targetSelectionRange ?? item.targetRange) }
      : { uri: item.uri, range: fromLspRange(item.range) }
  );
}

interface LspFileOperation {
  kind: 'create' | 'rename' | 'delete';
  uri?: string;
  oldUri?: string;
  newUri?: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string }; edits: LspTextEdit[] } | LspFileOperation)[];
}

/** Splits a workspace edit into edits for the open document and the number of other files it touches. */
export function splitWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined, documentUri: string) {
  const byUri = new Map<string, LspTextEdit[]>();
  let fileOperations = 0;
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
  }
  for (const change of edit?.documentChanges ?? []) {
    // A file created, renamed or deleted is another file, whatever its name.
    if (!('textDocument' in change)) {
      fileOperations += 1;
      continue;
    }
    byUri.set(change.textDocument.uri, [
      ...(byUri.get(change.textDocument.uri) ?? []),
      ...change.edits,
    ]);
  }
  const ownKey = [...byUri.keys()].find((uri) => sameUri(uri, documentUri));
  const own = (ownKey && byUri.get(ownKey)) || [];
  const otherFiles =
    [...byUri.keys()].filter((uri) => !sameUri(uri, documentUri)).length + fileOperations;
  return { own: own.map(toMonacoEdit), otherFiles };
}

export interface MonacoWorkspaceEdit {
  edits: {
    resource: string;
    textEdit: { range: MonacoRange; text: string };
    versionId: number | undefined;
  }[];
}

// oxlint-disable-next-line typescript/consistent-type-definitions -- needs an implicit index signature
export type LspCodeAction = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  data?: unknown;
  command?: unknown;
  disabled?: { reason: string };
};

/**
 * A code action as Monaco takes it, with its edits to the open document pointed at the editor's model.
 * PHPantom sends its actions with `data` and no `edit`; the edit comes from `codeAction/resolve`. A bare
 * command (no edit, no data) is null: the server's commands mean nothing to Monaco. `versionId` is the
 * model version the action was computed against: Monaco refuses the edit once the model has moved.
 */
export function toCodeAction(
  action: LspCodeAction,
  documentUri: string,
  modelUri: string,
  versionId?: number
) {
  if (!action.edit && action.data === undefined) {
    return null;
  }
  const split = action.edit ? splitWorkspaceEdit(action.edit, documentUri) : null;
  const edit: MonacoWorkspaceEdit | undefined = split
    ? { edits: split.own.map((textEdit) => ({ resource: modelUri, textEdit, versionId })) }
    : undefined;
  return {
    title: action.title,
    ...(action.kind ? { kind: action.kind } : {}),
    ...(action.isPreferred ? { isPreferred: true } : {}),
    ...(action.disabled?.reason ? { disabled: action.disabled.reason } : {}),
    ...(edit ? { edit } : {}),
    needsResolve: !action.edit,
    otherFiles: split?.otherFiles ?? 0,
  };
}

const before = (a: LspPosition, b: LspPosition): boolean =>
  a.line < b.line || (a.line === b.line && a.character < b.character);

/** The diagnostics that overlap or touch `range`, untouched: a code action request sends them back as sent. */
export function diagnosticsTouching<T extends { range: LspRange }>(
  diagnostics: T[],
  range: LspRange
): T[] {
  return diagnostics.filter(
    (diagnostic) =>
      !before(diagnostic.range.end, range.start) && !before(range.end, diagnostic.range.start)
  );
}

export interface LspSymbol {
  name: string;
  detail?: string;
  kind: number;
  range?: LspRange;
  selectionRange?: LspRange;
  location?: { range: LspRange };
  children?: LspSymbol[];
  containerName?: string;
}

/** Document symbols (tree or flat list) in Monaco's shape. LSP's symbol kinds are Monaco's plus one. */
export function toDocumentSymbols(symbols: LspSymbol[] | null | undefined): unknown[] {
  return (symbols ?? []).map((symbol) => {
    const range = fromLspRange(
      symbol.range ??
        symbol.location?.range ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        }
    );
    return {
      name: symbol.name,
      detail: symbol.detail ?? symbol.containerName ?? '',
      kind: Math.max(0, symbol.kind - 1),
      tags: [],
      range,
      selectionRange: symbol.selectionRange ? fromLspRange(symbol.selectionRange) : range,
      ...(symbol.children ? { children: toDocumentSymbols(symbol.children) } : {}),
    };
  });
}

/** Hover or documentation text of any LSP shape as one Markdown value, or undefined when there is none. */
export function markdownValue(
  contents: Parameters<typeof toMarkdown>[0]
): { value: string } | undefined {
  const text = toMarkdown(contents).join('\n\n');
  return text ? { value: text } : undefined;
}

export interface LspCompletionDetails {
  detail?: string;
  documentation?: Parameters<typeof toMarkdown>[0];
  additionalTextEdits?: LspTextEdit[];
}

/**
 * What a server fills in when asked to resolve a completion item: the documentation, a detail line and,
 * above all, the edits that go with picking it (the import that makes a symbol from another file usable).
 * Only what the server gave is returned, so nothing already known is overwritten with nothing.
 */
export function completionDetails(resolved: LspCompletionDetails | null | undefined) {
  if (!resolved) {
    return {};
  }
  const documentation = markdownValue(resolved.documentation);
  return {
    ...(resolved.detail ? { detail: resolved.detail } : {}),
    ...(documentation ? { documentation } : {}),
    ...(resolved.additionalTextEdits?.length
      ? { additionalTextEdits: resolved.additionalTextEdits.map(toMonacoEdit) }
      : {}),
  };
}

/** A completion label, with PHPantom's signature (`detail`) and class (`description`) when it sent them. */
export function toCompletionLabel(item: {
  label: string;
  labelDetails?: { detail?: string; description?: string };
}): string | { label: string; detail?: string; description?: string } {
  const { detail, description } = item.labelDetails ?? {};
  if (!detail && !description) {
    return item.label;
  }
  return {
    label: item.label,
    ...(detail ? { detail } : {}),
    ...(description ? { description } : {}),
  };
}

export interface LspInlayHint {
  position: LspPosition;
  label: string | { value: string; tooltip?: string }[];
  kind?: 1 | 2;
  tooltip?: string | { kind: string; value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/** An inlay hint in Monaco's shape. Both number their kinds the same way: 1 type, 2 parameter. */
export function toInlayHint(hint: LspInlayHint): {
  label: string | { label: string; tooltip?: string }[];
  position: { lineNumber: number; column: number };
  kind?: 1 | 2;
  tooltip?: string | { value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
} {
  const label =
    typeof hint.label === 'string'
      ? hint.label
      : hint.label.map((part) => ({
          label: part.value,
          ...(part.tooltip === undefined ? {} : { tooltip: tooltipText(part.tooltip) }),
        }));
  return {
    label,
    position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
    ...(hint.kind === undefined ? {} : { kind: hint.kind }),
    ...(hint.tooltip === undefined
      ? {}
      : {
          tooltip: typeof hint.tooltip === 'string' ? hint.tooltip : { value: hint.tooltip.value },
        }),
    ...(hint.paddingLeft ? { paddingLeft: true } : {}),
    ...(hint.paddingRight ? { paddingRight: true } : {}),
  };
}

// Why: a label part's tooltip may be MarkupContent on the wire even where the type says string.
const tooltipText = (tooltip: unknown): string =>
  typeof tooltip === 'string'
    ? tooltip
    : String((tooltip as { value?: unknown } | null)?.value ?? '');

/** A full semantic tokens answer as Monaco takes it; null when there is none. */
export function toSemanticTokens(
  result: { data: number[]; resultId?: string } | null
): { data: Uint32Array; resultId?: string } | null {
  if (!result || !Array.isArray(result.data)) {
    return null;
  }
  return {
    data: Uint32Array.from(result.data),
    ...(result.resultId ? { resultId: result.resultId } : {}),
  };
}

/**
 * Whether to ask for inlay hints: when the server offers them, and not in Blade, where PHPantom 1.1.0
 * hints its compiled view (`value:` after each `{{`, `args:` inside directives) rather than the code.
 */
export const inlayHintsWanted = (
  language: string,
  capabilities: Record<string, unknown>
): boolean => Boolean(capabilities.inlayHintProvider) && language !== 'blade';
