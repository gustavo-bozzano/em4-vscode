const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadServerInternals } = require('./serverInternals.js');

function getSymbolName(symbol) {
  return symbol.name || (symbol.args && symbol.args[0]);
}

function getSymbolKind(symbol) {
  return symbol.kind || (symbol.args && symbol.args[1]);
}

test('parser indexes fields and global variables as document symbols', () => {
  const { parseDocument } = loadServerInternals();
  const source = [
    'int GlobalCounter;',
    'object IndexedObject',
    '{',
    '  int MemberCounter;',
    '  void Run();',
    '};'
  ].join('\n');

  const parsed = parseDocument(source, 'file:///tmp/DocumentSymbols.script');
  const symbolsByName = new Map(parsed.symbols.map((symbol) => [getSymbolName(symbol), symbol]));

  assert.ok(symbolsByName.has('GlobalCounter'));
  assert.equal(getSymbolKind(symbolsByName.get('GlobalCounter')), 13);
  assert.ok(symbolsByName.has('MemberCounter'));
  assert.equal(getSymbolKind(symbolsByName.get('MemberCounter')), 8);
  assert.ok(symbolsByName.has('Run'));
});

test('local variables are not indexed as object fields', () => {
  const { parseDocument } = loadServerInternals();
  const source = [
    'object IndexedObject',
    '{',
    '  void Run()',
    '  {',
    '    int LocalCounter = 1;',
    '  }',
    '};'
  ].join('\n');

  const parsed = parseDocument(source, 'file:///tmp/LocalSymbol.script');
  const members = parsed.membersByOwner.get('IndexedObject');

  assert.ok(members);
  assert.equal(members.has('LocalCounter'), false);
  assert.equal(parsed.symbols.some((symbol) => getSymbolName(symbol) === 'LocalCounter'), false);
});

test('workspace script files are indexed even when they are not open', () => {
  const { loadSdk, parseDocument, buildSignatureHelp, buildCompletionItems } = loadServerInternals();
  const workspacePath = path.resolve(__dirname, 'scripts');
  loadSdk.bundledSdkPath = path.resolve(__dirname, '..', 'sdk');
  loadSdk([{ uri: pathToFileURL(workspacePath).toString(), name: 'fixtures' }]);

  const callLine = '    WorkspaceUtility(';
  const source = [
    'object Consumer : CommandScript',
    '{',
    '  void Run()',
    '  {',
    callLine,
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/WorkspaceConsumer.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);
  const position = { line: 4, character: callLine.length };

  const signatureHelp = buildSignatureHelp(document, localIndex, position);
  assert.ok(signatureHelp);
  assert.deepEqual(
    Array.from(signatureHelp.signatures, (signature) => signature.label),
    ['void WorkspaceUtility(int value)', 'void WorkspaceUtility(char *message)']
  );

  const completionItems = buildCompletionItems(document, localIndex, position);
  const utility = completionItems.find((item) => item.label === 'WorkspaceUtility');
  assert.ok(utility);
  assert.match(utility.detail, /\+1 overload/);
});

test('workspace symbol search includes indexed source fields and functions', () => {
  const { loadSdk, buildWorkspaceSymbols } = loadServerInternals();
  const workspacePath = path.resolve(__dirname, 'scripts');
  loadSdk.bundledSdkPath = path.resolve(__dirname, '..', 'sdk');
  loadSdk([{ uri: pathToFileURL(workspacePath).toString(), name: 'fixtures' }]);

  const functionSymbols = buildWorkspaceSymbols('WorkspaceUtility');
  assert.equal(functionSymbols.length, 2);
  assert.ok(functionSymbols.every((symbol) => getSymbolName(symbol) === 'WorkspaceUtility'));

  const fieldSymbols = buildWorkspaceSymbols('Counter');
  assert.ok(fieldSymbols.some((symbol) => getSymbolName(symbol) === 'Counter'));
});

test('open documents replace stale disk entries in workspace symbol search', () => {
  const { loadSdk, indexDocument, buildWorkspaceSymbols } = loadServerInternals();
  const workspacePath = path.resolve(__dirname, 'scripts');
  const sourcePath = path.resolve(workspacePath, 'Workspace', 'IndexedSymbols.script');
  const sourceUri = pathToFileURL(sourcePath).toString();
  loadSdk([{ uri: pathToFileURL(workspacePath).toString(), name: 'fixtures' }]);

  indexDocument({
    uri: sourceUri,
    getText: () => 'void UnsavedWorkspaceUtility(int value);'
  });

  assert.equal(
    buildWorkspaceSymbols('WorkspaceUtility').filter((symbol) => getSymbolName(symbol) === 'WorkspaceUtility').length,
    0
  );
  assert.equal(
    buildWorkspaceSymbols('UnsavedWorkspaceUtility').filter((symbol) => getSymbolName(symbol) === 'UnsavedWorkspaceUtility').length,
    1
  );
});

test('bundled SDK overloads are retained for signature help', () => {
  const { loadSdk, parseDocument, buildSignatureHelp } = loadServerInternals();
  loadSdk.bundledSdkPath = path.resolve(__dirname, '..', 'sdk');
  loadSdk([]);

  const callLine = '    Caller->PushActionMove(';
  const source = [
    'object Consumer : CommandScript',
    '{',
    '  void Run(GameObject *Caller)',
    '  {',
    callLine,
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/SdkOverloads.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);
  const result = buildSignatureHelp(document, localIndex, { line: 4, character: callLine.length });

  assert.ok(result);
  assert.equal(result.signatures.length, 3);
  assert.ok(result.signatures.every((signature) => signature.label.includes('PushActionMove')));
});
