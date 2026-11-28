// What this client tells PHPantom it can do. Pull diagnostics are deliberately absent: with
// `textDocument.diagnostic` missing the server pushes `textDocument/publishDiagnostics` instead.

const SEMANTIC_TOKEN_TYPES = [
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

const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'static',
  'readonly',
  'deprecated',
  'abstract',
  'definition',
  'defaultLibrary',
];

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  textDocument: {
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
      },
      dataSupport: true,
      isPreferredSupport: true,
      resolveSupport: { properties: ['edit'] },
    },
    completion: {
      completionItem: {
        deprecatedSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
        snippetSupport: true,
      },
      contextSupport: true,
    },
    definition: { linkSupport: false },
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    hover: { contentFormat: ['markdown', 'plaintext'] },
    inlayHint: { resolveSupport: { properties: ['tooltip'] } },
    publishDiagnostics: {
      relatedInformation: false,
      tagSupport: { valueSet: [1, 2] },
      versionSupport: false,
    },
    rangeFormatting: {},
    references: {},
    rename: { prepareSupport: true },
    semanticTokens: {
      formats: ['relative'],
      requests: { full: true },
      tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
      tokenTypes: SEMANTIC_TOKEN_TYPES,
    },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    synchronization: { didSave: false, willSave: false },
  },
  window: { workDoneProgress: true },
  workspace: {
    applyEdit: false,
    configuration: true,
    inlayHint: { refreshSupport: true },
    semanticTokens: { refreshSupport: true },
    workspaceEdit: { documentChanges: true },
    workspaceFolders: true,
  },
};

export { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, CLIENT_CAPABILITIES };
