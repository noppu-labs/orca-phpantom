// What this client tells PHPantom it can do. Pull diagnostics are deliberately absent: with
// `textDocument.diagnostic` missing the server pushes `textDocument/publishDiagnostics` instead.

export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'class',
  'interface',
  'enum',
  'type',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'function',
  'method',
  'decorator',
  'enumMember',
  'keyword',
  'comment',
];

export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'static',
  'readonly',
  'deprecated',
  'abstract',
  'definition',
  'defaultLibrary',
];

export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  window: { workDoneProgress: true },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    applyEdit: false,
    workspaceEdit: { documentChanges: true },
    semanticTokens: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { didSave: false, willSave: false },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
      },
      contextSupport: true,
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    definition: { linkSupport: false },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rangeFormatting: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
      },
      isPreferredSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit'] },
    },
    semanticTokens: {
      requests: { full: true },
      formats: ['relative'],
      tokenTypes: SEMANTIC_TOKEN_TYPES,
      tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
    },
    inlayHint: { resolveSupport: { properties: ['tooltip'] } },
    publishDiagnostics: {
      relatedInformation: false,
      versionSupport: false,
      tagSupport: { valueSet: [1, 2] },
    },
  },
};
