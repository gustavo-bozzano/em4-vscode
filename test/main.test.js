const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DiagnosticSeverity } = require('vscode-languageserver/node');
const { loadServerInternals } = require('./serverInternals.js');

// Global paths for Command and Mission folders and URI prefixes
const COMMAND_URI_PREFIX = 'file:///Command/';
const MISSION_URI_PREFIX = 'file:///Mission/';
const COMMAND_DIR = path.resolve(__dirname, 'scripts', 'Command');
const MISSION_DIR = path.resolve(__dirname, 'scripts', 'Mission');


test('all Command/*.script files have no diagnostics when bundled SDK is loaded', () => {
	const { loadSdk, indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const sdkPath = path.resolve(__dirname, '..', 'sdk');
	loadSdk.bundledSdkPath = sdkPath;
	loadSdk([]);

	const commandDir = COMMAND_DIR;
	const files = fs.readdirSync(commandDir).filter((file) => file.endsWith('.script')).sort();
	const failures = [];

	for (const file of files) {
		const content = fs.readFileSync(path.join(commandDir, file), 'utf8');
		const uri = `${COMMAND_URI_PREFIX}${file}`;
		const doc = { uri, getText: () => content };
		indexDocument(doc);
		validateTextDocument(doc);

		const diagnostics = (diagnosticsByUri.get(uri) || []).filter((d) => d.severity === DiagnosticSeverity.Error);
		if (diagnostics.length > 0) {
			failures.push(
				`${file}: ${diagnostics.length}\n${diagnostics.slice(0, 10).map((d) => `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`).join('\n')}`
			);
		}
	}

	assert.equal(failures.length, 0, failures.slice(0, 5).join('\n\n'));
});

test('all Mission/*.script files have no diagnostics when bundled SDK is loaded', () => {
	const { loadSdk, indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const sdkPath = path.resolve(__dirname, '..', 'sdk');
	loadSdk.bundledSdkPath = sdkPath;
	loadSdk([]);

	const missionDir = MISSION_DIR;
	const files = fs.readdirSync(missionDir).filter((file) => file.endsWith('.script')).sort();
	const failures = [];

	for (const file of files) {
		const content = fs.readFileSync(path.join(missionDir, file), 'utf8');
		const uri = `${MISSION_URI_PREFIX}${file}`;
		const doc = { uri, getText: () => content };
		indexDocument(doc);
		validateTextDocument(doc);

		const diagnostics = (diagnosticsByUri.get(uri) || []).filter((d) => d.severity === DiagnosticSeverity.Error);
		if (diagnostics.length > 0) {
			failures.push(
				`${file}: ${diagnostics.length}\n${diagnostics.slice(0, 10).map((d) => `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`).join('\n')}`
			);
		}
	}

	assert.equal(failures.length, 0, failures.slice(0, 5).join('\n\n'));
});

test('SDK enum members are indexed by enum type', () => {
	const { loadSdk, parseDocument } = loadServerInternals();
	const sdkPath = path.resolve(__dirname, '..', 'sdk');
	loadSdk.bundledSdkPath = sdkPath;
	loadSdk([]);

	const commandSdkPath = path.resolve(sdkPath, 'Command.script');
	const parsed = parseDocument(fs.readFileSync(commandSdkPath, 'utf8'), 'file:///sdk/Command.script');
	const members = parsed.enumMembersByType.get('CommandRestriction');

	assert.ok(members, 'Expected CommandRestriction enum to be indexed');
	assert.ok(members.has('RESTRICT_NONE'), 'Expected RESTRICT_NONE to be indexed');
	assert.ok(members.has('RESTRICT_SELFEXECUTE'), 'Expected RESTRICT_SELFEXECUTE to be indexed');
});

test('parser attaches block comment docs to following declaration', () => {
	const { parseDocument } = loadServerInternals();
	const source = [
		'namespace DocTest',
		'{',
		'  /*',
		'   Block line 1.',
		'   Block line 2.',
		'  */',
		'  void Foo();',
		'};'
	].join('\n');

	const parsed = parseDocument(source, 'file:///tmp/DocTest.script');
	const foo = parsed.definitions.get('Foo');

	assert.ok(foo, 'Expected Foo definition');
	assert.equal(foo.documentation, 'Block line 1.\nBlock line 2.');
});

test('workspace resolution supports modern and legacy LSP clients', () => {
	const { resolveWorkspaceFolders } = loadServerInternals();
	const modern = resolveWorkspaceFolders({
		workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
		rootUri: 'file:///ignored'
	});
	const legacy = resolveWorkspaceFolders({ workspaceFolders: null, rootUri: 'file:///legacy-workspace' });

	assert.equal(modern.length, 1);
	assert.equal(modern[0].uri, 'file:///workspace');
	assert.equal(legacy.length, 1);
	assert.equal(legacy[0].uri, 'file:///legacy-workspace');
});

test('autocomplete suggests enum values for enum-typed method arguments', () => {
	const { loadSdk, parseDocument, buildCompletionItems } = loadServerInternals();
	const sdkPath = path.resolve(__dirname, '..', 'sdk');
	loadSdk.bundledSdkPath = sdkPath;
	loadSdk([]);

	const script = [
		'object TestCmd : CommandScript',
		'{',
		'  void Foo()',
		'  {',
		'    AddRestriction(',
		'  }',
		'};'
	].join('\n');
	const uri = 'file:///tmp/TestAutocomplete.script';
	const document = { uri, getText: () => script };
	const localIndex = parseDocument(script, uri);
	const position = { line: 4, character: '    AddRestriction('.length };
	const items = buildCompletionItems(document, localIndex, position);
	const labels = new Set(items.map((item) => item.label));

	assert.ok(labels.has('RESTRICT_NONE'), 'Expected enum suggestions to include RESTRICT_NONE');
	assert.ok(labels.has('RESTRICT_SELFEXECUTE'), 'Expected enum suggestions to include RESTRICT_SELFEXECUTE');
});

test('autocomplete suggests inherited base methods in object constructor scope', () => {
	const { loadSdk, parseDocument, buildCompletionItems } = loadServerInternals();
	const sdkPath = path.resolve(__dirname, '..', 'sdk');
	loadSdk.bundledSdkPath = sdkPath;
	loadSdk([]);

	const script = [
		'object TestCmd : CommandScript',
		'{',
		'  TestCmd()',
		'  {',
		'    Set',
		'  }',
		'};'
	].join('\n');
	const uri = 'file:///tmp/TestInheritedAutocomplete.script';
	const document = { uri, getText: () => script };
	const localIndex = parseDocument(script, uri);
	const position = { line: 4, character: '    Set'.length };
	const items = buildCompletionItems(document, localIndex, position);
	const labels = new Set(items.map((item) => item.label));

	assert.ok(labels.has('SetIcon'), 'Expected inherited CommandScript method SetIcon');
	assert.ok(labels.has('SetCursor'), 'Expected inherited CommandScript method SetCursor');
	assert.ok(labels.has('SetValidTargets'), 'Expected inherited CommandScript method SetValidTargets');
});

test('semicolon validation reports statements without a trailing semicolon', () => {
	const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const source = [
		'object TestSemicolon : CommandScript',
		'{',
		'  void Foo()',
		'  {',
		'    int value = 1',
		'    value = 2',
		'    do',
		'    {',
		'      value = 3;',
		'    }',
		'    while(false)',
		'  }',
		'};'
	].join('\n');
	const uri = 'file:///tmp/TestSemicolonValidation.script';
	const doc = { uri, getText: () => source };

	indexDocument(doc);
	validateTextDocument(doc);

	const diagnostics = diagnosticsByUri.get(uri) || [];
	const semicolonDiagnostics = diagnostics.filter((d) => d.message === "Missing ';' at end of line");
	assert.equal(semicolonDiagnostics.length, 3, JSON.stringify(diagnostics, null, 2));
});

test('semicolon validation ignores block and control-flow lines', () => {
	const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const source = [
		'object TestSemicolonOk : CommandScript',
		'{',
		'  void Foo()',
		'  {',
		'    int value = 1;',
		'    if (true)',
		'    {',
		'      value = 2;',
		'    }',
		'    else',
		'      value = 3;',
		'    for (int i = 0; i < 1; i++)',
		'      value = i;',
		'    switch(value)',
		'    {',
		'      case 0:',
		'        value = 4;',
		'        break;',
		'      default:',
		'        value = 5;',
		'        break;',
		'    }',
		'  }',
		'};'
	].join('\n');
	const uri = 'file:///tmp/TestSemicolonValidationOk.script';
	const doc = { uri, getText: () => source };

	indexDocument(doc);
	validateTextDocument(doc);

	const diagnostics = diagnosticsByUri.get(uri) || [];
	const semicolonDiagnostics = diagnostics.filter((d) => d.message === "Missing ';' at end of line");
	assert.equal(semicolonDiagnostics.length, 0, JSON.stringify(diagnostics, null, 2));
});

test('delimiter validation reports unclosed parentheses', () => {
	const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const source = [
		'object TestParenthesis : CommandScript',
		'{',
		'  void Foo()',
		'  {',
		'    if (true',
		'      return;',
		'  }',
		'};'
	].join('\n');
	const uri = 'file:///tmp/TestParenthesis.script';
	const doc = { uri, getText: () => source };

	indexDocument(doc);
	validateTextDocument(doc);

	const diagnostics = diagnosticsByUri.get(uri) || [];
	assert.ok(
		diagnostics.some((diagnostic) => diagnostic.message === "Delimiter '(' is not closed"),
		JSON.stringify(diagnostics, null, 2)
	);
});

test('delimiter validation ignores delimiters and comments inside single-quoted literals', () => {
	const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const source = [
		'object TestCharacters : CommandScript',
		'{',
		'  void Foo()',
		'  {',
		"    char closeParen = ')';",
		"    char openBrace = '{';",
		"    char slash = '/';",
		'  }',
		'};'
	].join('\n');
	const uri = 'file:///tmp/TestCharacters.script';
	const doc = { uri, getText: () => source };

	indexDocument(doc);
	validateTextDocument(doc);

	const diagnostics = diagnosticsByUri.get(uri) || [];
	const delimiterDiagnostics = diagnostics.filter((diagnostic) => diagnostic.message.startsWith('Delimiter'));
	assert.equal(delimiterDiagnostics.length, 0, JSON.stringify(diagnostics, null, 2));
});

test('validation reports unterminated strings and block comments', () => {
	const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
	const cases = [
		{
			uri: 'file:///tmp/TestUnclosedString.script',
			source: 'const char NAME[] = "not closed',
			message: 'String literal starting with " is not closed'
		},
		{
			uri: 'file:///tmp/TestUnclosedComment.script',
			source: '/* not closed',
			message: 'Block comment is not closed'
		}
	];

	for (const testCase of cases) {
		const doc = { uri: testCase.uri, getText: () => testCase.source };
		indexDocument(doc);
		validateTextDocument(doc);
		const diagnostics = diagnosticsByUri.get(testCase.uri) || [];
		assert.ok(
			diagnostics.some((diagnostic) => diagnostic.message === testCase.message),
			JSON.stringify(diagnostics, null, 2)
		);
	}
});
