// Adapted from actus7/orca-autocomplete editor/src/lsp-convert.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import type { LspContentChange } from '../../src/protocol.ts';
import { isRecord, isTruthy } from '../../src/utils/json.ts';
import { sameUri } from '../../src/utils/uri.ts';

// Conversions between the Language Server Protocol and Monaco. Pure data in, pure data out, so Node can test them: the Monaco-aware code only wraps these.
// The guards check only what the code branches on; the fields are taken as LSP types them.

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

// LSP positions count from 0 and Monaco's from 1; both measure columns in UTF-16 code units.
const toLspPosition = (position: { lineNumber: number; column: number }): LspPosition => ({
  character: position.column - 1,
  line: position.lineNumber - 1,
});

const fromLspRange = (range: LspRange): MonacoRange => ({
  endColumn: range.end.character + 1,
  endLineNumber: range.end.line + 1,
  startColumn: range.start.character + 1,
  startLineNumber: range.start.line + 1,
});

const toLspRange = (range: MonacoRange): LspRange => ({
  end: { character: range.endColumn - 1, line: range.endLineNumber - 1 },
  start: { character: range.startColumn - 1, line: range.startLineNumber - 1 },
});

/** One of Monaco's content changes as an LSP incremental change; Monaco's ranges are against the text before it. */
const toLspContentChange = (change: {
  range: MonacoRange;
  text: string;
}): Extract<LspContentChange, { range: unknown }> => ({
  range: toLspRange(change.range),
  text: change.text,
});

// LSP's DiagnosticSeverity (1 is error) and Monaco's MarkerSeverity.
const LSP_WARNING = 2;
const LSP_INFORMATION = 3;
const LSP_HINT = 4;
const MARKER_ERROR = 8;
const MARKER_WARNING = 4;
const MARKER_INFO = 2;
const MARKER_HINT = 1;

/** LSP severity (1 error ... 4 hint) as Monaco's MarkerSeverity (8, 4, 2, 1). */
function markerSeverity(severity: number | undefined): number {
  if (severity === undefined) return MARKER_ERROR;
  switch (severity) {
    case LSP_WARNING: {
      return MARKER_WARNING;
    }
    case LSP_INFORMATION: {
      return MARKER_INFO;
    }
    case LSP_HINT: {
      return MARKER_HINT;
    }
    default: {
      return MARKER_ERROR;
    }
  }
}

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
  tags?: number[];
}

/** Whether every diagnostic in `list` is an object; the list itself is kept as sent, never copied. */
const isDiagnosticList = (list: unknown[]): list is LspDiagnostic[] => list.every(isRecord);

/** A diagnostic as a Monaco marker. Tags (unnecessary code, deprecated) use the same numbers in both. */
function toMarker(diagnostic: LspDiagnostic): MonacoRange & {
  severity: number;
  message: string;
  code?: string;
  source?: string;
  tags?: number[];
} {
  const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
  return {
    ...fromLspRange(diagnostic.range),
    message: diagnostic.message,
    severity: markerSeverity(diagnostic.severity),
    ...(code === undefined ? {} : { code: String(code) }),
    // Why isTruthy: a server may send null where LSP leaves a field out, and null is left out too.
    ...(isTruthy(diagnostic.source) ? { source: diagnostic.source } : {}),
    ...(isTruthy(diagnostic.tags?.length) ? { tags: diagnostic.tags } : {}),
  };
}

const COMPLETION_KIND_NAMES = {
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
} as const;
type CompletionKindName = (typeof COMPLETION_KIND_NAMES)[keyof typeof COMPLETION_KIND_NAMES];
const completionKindNames: Partial<Record<number, CompletionKindName>> = COMPLETION_KIND_NAMES;

/** The name of Monaco's CompletionItemKind member for an LSP kind. */
const completionKindName = (kind: number | undefined): CompletionKindName =>
  completionKindNames[kind ?? 1] ?? 'Text';

type MarkedString = string | { language: string; value: string };
interface Markup {
  kind?: string;
  value: string;
}

/** Hover and documentation text of any LSP shape as Markdown. */
function toMarkdown(contents: MarkedString | MarkedString[] | Markup | undefined | null): string[] {
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
  return text.replaceAll(/[\\`*_{}[\]()#+\-.!|>]/gu, String.raw`\$&`);
}

interface LspHover {
  contents: MarkedString | MarkedString[] | Markup;
  range?: LspRange;
}

const isHover = (value: unknown): value is LspHover => isRecord(value);

interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: string | Markup;
    parameters?: { label: string | [number, number]; documentation?: string | Markup }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

const isSignatureHelp = (value: unknown): value is LspSignatureHelp => isRecord(value);

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

const toMonacoEdit = (edit: LspTextEdit): { range: MonacoRange; text: string } => ({
  range: fromLspRange(edit.range),
  text: edit.newText,
});

/** Whether `value` can be read as a range: an object whose `start` and `end` are there. */
const isLspRange = (value: unknown): value is LspRange =>
  isRecord(value) &&
  value.start !== undefined &&
  value.start !== null &&
  value.end !== undefined &&
  value.end !== null;

/**
 * Where a prepareRename answer puts the name: its `range`, or the answer itself when it is a bare range.
 * Throws when it has neither: there is no range to read.
 */
function renameRange(answer: unknown): LspRange {
  const target = isRecord(answer) ? (answer.range ?? answer) : answer;
  if (!isLspRange(target)) throw new TypeError('the prepareRename answer has no range');
  return target;
}

type LspLocation =
  | { uri: string; range: LspRange }
  | { targetUri: string; targetSelectionRange: LspRange; targetRange: LspRange };

const isLocation = (value: unknown): value is LspLocation => isRecord(value);

/** Locations (or links) as plain {uri, range}, whichever shape the server used, or none. */
function normalizeLocations(result: unknown): { uri: string; range: MonacoRange }[] {
  let list: unknown[] = [];
  if (Array.isArray(result)) list = result;
  else if (isTruthy(result)) list = [result];
  return list.map((item) => {
    // Why throw: anything else has no location to read, and reading one from it throws too.
    if (!isLocation(item)) throw new TypeError('a location is not an object');
    return 'targetUri' in item
      ? { range: fromLspRange(item.targetSelectionRange ?? item.targetRange), uri: item.targetUri }
      : { range: fromLspRange(item.range), uri: item.uri };
  });
}

interface LspFileOperation {
  kind: 'create' | 'rename' | 'delete';
  uri?: string;
  oldUri?: string;
  newUri?: string;
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string }; edits: LspTextEdit[] } | LspFileOperation)[];
}

const isWorkspaceEdit = (value: unknown): value is LspWorkspaceEdit => isRecord(value);
const isTextEditList = (value: unknown): value is LspTextEdit[] => Array.isArray(value);

/** Splits a workspace edit into edits for the open document and the number of other files it touches. */
function splitWorkspaceEdit(
  edit: LspWorkspaceEdit | null | undefined,
  documentUri: string
): { own: { range: MonacoRange; text: string }[]; otherFiles: number } {
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
  const own = ownKey === undefined || ownKey === '' ? [] : (byUri.get(ownKey) ?? []);
  const otherFiles =
    [...byUri.keys()].filter((uri) => !sameUri(uri, documentUri)).length + fileOperations;
  return { otherFiles, own: own.map(toMonacoEdit) };
}

interface MonacoWorkspaceEdit {
  edits: {
    resource: string;
    textEdit: { range: MonacoRange; text: string };
    versionId: number | undefined;
  }[];
}

interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  data?: unknown;
  command?: unknown;
  disabled?: { reason: string };
}

const isCodeAction = (value: unknown): value is LspCodeAction => isRecord(value);
const isCodeActionList = (value: unknown): value is LspCodeAction[] => Array.isArray(value);

/**
 * A code action as Monaco takes it, with its edits to the open document pointed at the editor's model.
 * PHPantom sends its actions with `data` and no `edit`; the edit comes from `codeAction/resolve`. A bare
 * command (no edit, no data) is null: the server's commands mean nothing to Monaco. `versionId` is the
 * model version the action was computed against: Monaco refuses the edit once the model has moved.
 */
function toCodeAction(
  action: LspCodeAction,
  documentUri: string,
  modelUri: string,
  versionId?: number
): {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: string;
  edit?: MonacoWorkspaceEdit;
  needsResolve: boolean;
  otherFiles: number;
} | null {
  if (!action.edit && action.data === undefined) {
    return null;
  }
  const split = action.edit ? splitWorkspaceEdit(action.edit, documentUri) : null;
  const edit: MonacoWorkspaceEdit | undefined = split
    ? { edits: split.own.map((textEdit) => ({ resource: modelUri, textEdit, versionId })) }
    : undefined;
  const reason = action.disabled?.reason;
  return {
    title: action.title,
    ...(isTruthy(action.kind) ? { kind: action.kind } : {}),
    ...(isTruthy(action.isPreferred) ? { isPreferred: true } : {}),
    ...(isTruthy(reason) ? { disabled: reason } : {}),
    ...(edit ? { edit } : {}),
    needsResolve: !action.edit,
    otherFiles: split?.otherFiles ?? 0,
  };
}

const before = (left: LspPosition, right: LspPosition): boolean =>
  left.line < right.line || (left.line === right.line && left.character < right.character);

/** The diagnostics that overlap or touch `range`, untouched: a code action request sends them back as sent. */
function diagnosticsTouching<Diagnostic extends { range: LspRange }>(
  diagnostics: Diagnostic[],
  range: LspRange
): Diagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      !before(diagnostic.range.end, range.start) && !before(range.end, diagnostic.range.start)
  );
}

interface LspSymbol {
  name: string;
  detail?: string;
  kind: number;
  range?: LspRange;
  selectionRange?: LspRange;
  location?: { range: LspRange };
  children?: LspSymbol[];
  containerName?: string;
}

interface MonacoDocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  range: MonacoRange;
  selectionRange: MonacoRange;
  tags: never[];
  children?: MonacoDocumentSymbol[];
}

const isSymbolList = (value: unknown): value is LspSymbol[] => Array.isArray(value);

/** Document symbols (tree or flat list) in Monaco's shape. LSP's symbol kinds are Monaco's plus one. */
function toDocumentSymbols(symbols: LspSymbol[] | null | undefined): MonacoDocumentSymbol[] {
  return (symbols ?? []).map((symbol) => {
    const range = fromLspRange(
      symbol.range ??
        symbol.location?.range ?? {
          end: { character: 0, line: 0 },
          start: { character: 0, line: 0 },
        }
    );
    return {
      detail: symbol.detail ?? symbol.containerName ?? '',
      kind: Math.max(0, symbol.kind - 1),
      name: symbol.name,
      range,
      selectionRange: symbol.selectionRange ? fromLspRange(symbol.selectionRange) : range,
      tags: [],
      ...(symbol.children ? { children: toDocumentSymbols(symbol.children) } : {}),
    };
  });
}

/** Hover or documentation text of any LSP shape as one Markdown value, or undefined when there is none. */
function markdownValue(contents: Parameters<typeof toMarkdown>[0]): { value: string } | undefined {
  const text = toMarkdown(contents).join('\n\n');
  return text ? { value: text } : undefined;
}

interface LspCompletionDetails {
  detail?: string;
  documentation?: Parameters<typeof toMarkdown>[0];
  additionalTextEdits?: LspTextEdit[];
}

/** A completion's edit: a plain text edit, or LSP's insert and replace ranges. */
type LspCompletionEdit =
  | LspTextEdit
  | { newText: string; range?: undefined; insert: LspRange; replace: LspRange };

interface LspCompletionItem extends LspCompletionDetails {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  textEdit?: LspCompletionEdit;
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  preselect?: boolean;
  commitCharacters?: string[];
  deprecated?: boolean;
  tags?: number[];
}

const isCompletionDetails = (value: unknown): value is LspCompletionDetails => isRecord(value);
const isCompletionItemList = (value: unknown): value is LspCompletionItem[] => Array.isArray(value);

/** A completion answer's items, from a bare list or a CompletionList; none when there is neither. */
function completionItems(result: unknown): LspCompletionItem[] {
  let items: unknown = [];
  if (Array.isArray(result)) items = result;
  else if (isRecord(result)) items = result.items ?? [];
  // Why throw: anything else has no items to read, and mapping over it throws too.
  if (!isCompletionItemList(items)) throw new TypeError('completion items are not a list');
  return items;
}

/**
 * What a server fills in when asked to resolve a completion item: the documentation, a detail line and,
 * above all, the edits that go with picking it (the import that makes a symbol from another file usable).
 * Only what the server gave is returned, so nothing already known is overwritten with nothing.
 */
function completionDetails(resolved: unknown): {
  detail?: string;
  documentation?: { value: string };
  additionalTextEdits?: { range: MonacoRange; text: string }[];
} {
  if (!isCompletionDetails(resolved)) {
    return {};
  }
  const documentation = markdownValue(resolved.documentation);
  return {
    ...(isTruthy(resolved.detail) ? { detail: resolved.detail } : {}),
    ...(documentation ? { documentation } : {}),
    ...(isTruthy(resolved.additionalTextEdits?.length)
      ? { additionalTextEdits: resolved.additionalTextEdits?.map(toMonacoEdit) }
      : {}),
  };
}

/** A completion label, with PHPantom's signature (`detail`) and class (`description`) when it sent them. */
function toCompletionLabel(item: {
  label: string;
  labelDetails?: { detail?: string; description?: string };
}): string | { label: string; detail?: string; description?: string } {
  const { detail, description } = item.labelDetails ?? {};
  const hasDetail = isTruthy(detail);
  const hasDescription = isTruthy(description);
  if (!hasDetail && !hasDescription) {
    return item.label;
  }
  return {
    label: item.label,
    ...(hasDetail ? { detail } : {}),
    ...(hasDescription ? { description } : {}),
  };
}

interface LspInlayHint {
  position: LspPosition;
  label: string | { value: string; tooltip?: string }[];
  kind?: 1 | 2;
  tooltip?: string | { kind: string; value: string };
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

const isInlayHintList = (value: unknown): value is LspInlayHint[] => Array.isArray(value);

/** An inlay hint in Monaco's shape. Both number their kinds the same way: 1 type, 2 parameter. */
function toInlayHint(hint: LspInlayHint): {
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
    position: { column: hint.position.character + 1, lineNumber: hint.position.line + 1 },
    ...(hint.kind === undefined ? {} : { kind: hint.kind }),
    ...(hint.tooltip === undefined
      ? {}
      : {
          tooltip: typeof hint.tooltip === 'string' ? hint.tooltip : { value: hint.tooltip.value },
        }),
    ...(isTruthy(hint.paddingLeft) ? { paddingLeft: true } : {}),
    ...(isTruthy(hint.paddingRight) ? { paddingRight: true } : {}),
  };
}

// Why: a label part's tooltip may be MarkupContent on the wire even where the type says string.
const tooltipText = (tooltip: unknown): string =>
  typeof tooltip === 'string' ? tooltip : String(isRecord(tooltip) ? (tooltip.value ?? '') : '');

interface LspSemanticTokens {
  data: number[];
  resultId?: string;
}

const isSemanticTokens = (value: unknown): value is LspSemanticTokens =>
  isRecord(value) && Array.isArray(value.data);

/** A full semantic tokens answer as Monaco takes it; null when there is none. */
function toSemanticTokens(result: unknown): { data: Uint32Array; resultId?: string } | null {
  if (!isSemanticTokens(result)) {
    return null;
  }
  return {
    data: Uint32Array.from(result.data),
    ...(isTruthy(result.resultId) ? { resultId: result.resultId } : {}),
  };
}

interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

const isSemanticTokensLegend = (value: unknown): value is SemanticTokensLegend => isRecord(value);

/**
 * Whether to ask for inlay hints: when the server offers them, and not in Blade, where PHPantom 1.1.0
 * hints its compiled view (`value:` after each `{{`, `args:` inside directives) rather than the code.
 */
const inlayHintsWanted = (language: string, capabilities: Record<string, unknown>): boolean =>
  Boolean(capabilities.inlayHintProvider) && language !== 'blade';

export {
  toLspPosition,
  fromLspRange,
  toLspRange,
  toLspContentChange,
  markerSeverity,
  toMarker,
  completionKindName,
  toMarkdown,
  toMonacoEdit,
  normalizeLocations,
  splitWorkspaceEdit,
  toCodeAction,
  diagnosticsTouching,
  toDocumentSymbols,
  markdownValue,
  completionDetails,
  completionItems,
  toCompletionLabel,
  toInlayHint,
  toSemanticTokens,
  inlayHintsWanted,
  renameRange,
  isCodeAction,
  isCodeActionList,
  isDiagnosticList,
  isHover,
  isInlayHintList,
  isSemanticTokensLegend,
  isSignatureHelp,
  isSymbolList,
  isTextEditList,
  isWorkspaceEdit,
};
export type {
  LspPosition,
  LspRange,
  MonacoRange,
  LspDiagnostic,
  LspTextEdit,
  LspLocation,
  LspWorkspaceEdit,
  MonacoWorkspaceEdit,
  LspCodeAction,
  LspSymbol,
  LspCompletionDetails,
  LspCompletionItem,
  LspInlayHint,
};
