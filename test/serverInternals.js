const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TEST_EXPORTS = [
  'parseDocument',
  'resolveOwnerType',
  'sanitizeLinesForAnalysis',
  'loadSdk',
  'indexDocument',
  'validateTextDocument',
  'buildCompletionItems',
  'resolveDefinitionAtPosition',
  'formatScriptText',
  'findAllOccurrencesInDocument'
];

function loadServerInternals() {
  const serverPath = path.resolve(__dirname, '..', 'server', 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');

  const diagnosticsByUri = new Map();

  const fakeConnection = {
    console: { warn: () => { } },
    sendDiagnostics: (payload) => {
      diagnosticsByUri.set(payload.uri, payload.diagnostics || []);
    },
    onInitialize: () => { },
    onInitialized: () => { },
    onCompletion: () => { },
    onHover: () => { },
    onDefinition: () => { },
    onDocumentSymbol: () => { },
    onDocumentFormatting: () => { },
    onPrepareRename: () => { },
    onRenameRequest: () => { },
    listen: () => { }
  };

  const fakeServerModule = {
    createConnection: () => fakeConnection,
    TextDocuments: class {
      constructor() {
        this.syncKind = 1;
      }
      all() { return []; }
      get() { return null; }
      onDidOpen() { }
      onDidChangeContent() { }
      onDidClose() { }
      listen() { }
    },
    ProposedFeatures: { all: {} },
    DiagnosticSeverity: { Warning: 2 },
    CompletionItemKind: { Keyword: 14, Method: 2, Field: 5, Function: 3, Reference: 18, EnumMember: 21 },
    SymbolKind: { Namespace: 3, Class: 5, Enum: 10, Constant: 14, Function: 12 },
    SymbolInformation: { create: (...args) => ({ args }) },
    MarkupKind: { Markdown: 'markdown' },
    Location: { create: (...args) => ({ args }) },
    Range: {
      create: (startLine, startCharacter, endLine, endCharacter) => ({
        args: [startLine, startCharacter, endLine, endCharacter],
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter }
      })
    }
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (id === 'vscode-languageserver/node') return fakeServerModule;
      if (id === 'vscode-languageserver-textdocument') return { TextDocument: class { } };
      return require(id);
    }
  };

  const wrapped = `${source}\nmodule.exports.__test__ = { ${TEST_EXPORTS.join(', ')} };`;
  vm.runInNewContext(wrapped, sandbox, { filename: serverPath });
  return { ...sandbox.module.exports.__test__, diagnosticsByUri };
}

module.exports = { loadServerInternals };