const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { loadServerInternals } = require('./serverInternals.js');

const repositoryRoot = path.resolve(__dirname, '..');
const workspacePath = path.resolve(__dirname, 'scripts');
const libraryPath = path.resolve(workspacePath, 'Library', 'lang.lib');

test('VS Code associates .lib files with the EM4 Script language', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const language = manifest.contributes.languages.find((entry) => entry.id === 'em4script');

  assert.ok(language, 'Expected em4script language contribution');
  assert.ok(language.extensions.includes('.script'));
  assert.ok(language.extensions.includes('.lib'));
});

test('the language client watches .script and .lib files', () => {
  const clientSource = fs.readFileSync(path.join(repositoryRoot, 'client', 'extension.js'), 'utf8');
  assert.match(clientSource, /\*\.\{script,lib\}/);
});

test('workspace .lib declarations provide completion, diagnostics and definitions', () => {
  const {
    loadSdk,
    parseDocument,
    buildCompletionItems,
    resolveDefinitionAtPosition,
    indexDocument,
    validateTextDocument,
    diagnosticsByUri
  } = loadServerInternals();

  loadSdk([{ uri: pathToFileURL(workspacePath).toString(), name: 'fixtures' }]);

  const source = [
    'object AskPerson : CommandScript',
    '{',
    '  void PushActions(GameObject *Caller)',
    '  {',
    '    Lang::PlayHint("BHint_0");',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/AskPersonLibSupport.script';
  const document = { uri, getText: () => source };
  const localIndex = parseDocument(source, uri);

  const completionLine = '    Lang::Pla';
  const completionDocument = {
    uri: 'file:///tmp/AskPersonCompletion.script',
    getText: () => [
      'object AskPerson : CommandScript',
      '{',
      '  void PushActions(GameObject *Caller)',
      '  {',
      completionLine,
      '  }',
      '};'
    ].join('\n')
  };
  const completionIndex = parseDocument(completionDocument.getText(), completionDocument.uri);
  const completions = buildCompletionItems(
    completionDocument,
    completionIndex,
    { line: 4, character: completionLine.length }
  );
  assert.ok(completions.some((item) => item.label === 'PlayHint'));

  const definitionLine = source.split('\n')[4];
  const definition = resolveDefinitionAtPosition(
    document,
    localIndex,
    { line: 4, character: definitionLine.indexOf('PlayHint') + 3 }
  );
  assert.ok(definition, 'Expected Lang::PlayHint to resolve to lang.lib');
  assert.equal(path.resolve(fileURLToPath(definition.args[0])), libraryPath);

  indexDocument(document);
  validateTextDocument(document);
  const diagnostics = diagnosticsByUri.get(uri) || [];
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.message.includes("Identifier 'Lang' is not declared")),
    false,
    JSON.stringify(diagnostics, null, 2)
  );
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.message.includes("Member 'PlayHint' was not found")),
    false,
    JSON.stringify(diagnostics, null, 2)
  );
});
