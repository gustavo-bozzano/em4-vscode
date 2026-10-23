const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadServerInternals } = require('./serverInternals.js');

test('signature help resolves a local function and tracks nested arguments', () => {
  const { parseDocument, buildSignatureHelp } = loadServerInternals();
  const callLine = '    Run(GetValue(1, 2), "a,b", ';
  const source = [
    'void Run(int count, char *message, bool enabled = false)',
    '{',
    '}',
    'object Test : CommandScript',
    '{',
    '  void Execute()',
    '  {',
    callLine,
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/SignatureHelpLocal.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);

  const result = buildSignatureHelp(
    document,
    localIndex,
    { line: 7, character: callLine.length }
  );

  assert.ok(result);
  assert.equal(result.activeSignature, 0);
  assert.equal(result.activeParameter, 2);
  assert.equal(result.signatures[0].label, 'void Run(int count, char *message, bool enabled = false)');
  assert.equal(
    Array.from(result.signatures[0].parameters, (parameter) => parameter.label).join('|'),
    ['int count', 'char *message', 'bool enabled = false'].join('|')
  );
});

test('signature help resolves inherited SDK methods', () => {
  const { loadSdk, parseDocument, buildSignatureHelp } = loadServerInternals();
  loadSdk.bundledSdkPath = path.resolve(__dirname, '..', 'sdk');
  loadSdk([]);

  const callLine = '    SetRestrictions(';
  const source = [
    'object Test : CommandScript',
    '{',
    '  Test()',
    '  {',
    callLine,
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/SignatureHelpInherited.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);

  const result = buildSignatureHelp(
    document,
    localIndex,
    { line: 4, character: callLine.length }
  );

  assert.ok(result);
  assert.equal(result.activeParameter, 0);
  assert.equal(result.signatures[0].label, 'void SetRestrictions(int Restrictions_)');
  assert.equal(result.signatures[0].parameters[0].label, 'int Restrictions_');
});

test('signature help resolves multiline .lib calls with documentation', () => {
  const { loadSdk, parseDocument, buildSignatureHelp } = loadServerInternals();
  const workspacePath = path.resolve(__dirname, 'scripts');
  loadSdk([{ uri: pathToFileURL(workspacePath).toString(), name: 'fixtures' }]);

  const argumentLine = '      "BHint_0",';
  const activeLine = '      ';
  const source = [
    'object AskPerson : CommandScript',
    '{',
    '  void PushActions(GameObject *Caller)',
    '  {',
    '    Lang::PlayHint(',
    argumentLine,
    activeLine,
    '    );',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/SignatureHelpLibrary.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);

  const result = buildSignatureHelp(
    document,
    localIndex,
    { line: 6, character: activeLine.length }
  );

  assert.ok(result);
  assert.equal(result.activeParameter, 1);
  assert.equal(result.signatures[0].label, 'void PlayHint(char *message, bool prefixFolder = false)');
  assert.equal(result.signatures[0].documentation.value, 'Displays a localized hint.');
});

test('signature help returns null outside a function call', () => {
  const { parseDocument, buildSignatureHelp } = loadServerInternals();
  const source = 'int value = 1;';
  const uri = 'file:///tmp/SignatureHelpNone.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);

  assert.equal(buildSignatureHelp(document, localIndex, { line: 0, character: source.length }), null);
});
