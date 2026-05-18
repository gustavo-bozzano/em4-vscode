const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadServerInternals } = require('./serverInternals.js');

test('rename renames all occurrences of a local variable in a document', () => {
  const { findAllOccurrencesInDocument } = loadServerInternals();
  const script = [
    'object TestRename : CommandScript',
    '{',
    '  void Foo()',
    '  {',
    '    int counter = 0;',
    '    counter = counter + 1;',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/TestRename.script';
  const document = { uri, getText: () => script };

  const occurrences = findAllOccurrencesInDocument(document, 'counter');
  assert.equal(occurrences.length, 3, 'Expected 3 occurrences of counter');

  const lines = occurrences.map((r) => r.start.line);
  assert.ok(lines.includes(4), 'Expected occurrence on declaration line');
  assert.ok(lines.includes(5), 'Expected occurrences on assignment line');
});

test('rename does not match substrings inside longer identifiers', () => {
  const { findAllOccurrencesInDocument } = loadServerInternals();
  const script = [
    'object TestRename : CommandScript',
    '{',
    '  void Foo()',
    '  {',
    '    int count = 0;',
    '    int counter = 0;',
    '    count = count + 1;',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/TestRenameSubstring.script';
  const document = { uri, getText: () => script };

  const occurrences = findAllOccurrencesInDocument(document, 'count');
  const matchedLines = occurrences.map((r) => r.start.line);
  // Line 5 has 'counter', which must not match 'count'
  assert.ok(!matchedLines.includes(5), 'Expected no match inside counter identifier');
  // Lines 4 and 6 have genuine 'count' tokens
  assert.ok(matchedLines.includes(4), 'Expected match on declaration line');
  assert.equal(matchedLines.filter((l) => l === 6).length, 2, 'Expected 2 matches on assignment line');
});

test('rename skips occurrences inside comments', () => {
  const { findAllOccurrencesInDocument } = loadServerInternals();
  const script = [
    'object TestRenameComment : CommandScript',
    '{',
    '  // int myVar declared here',
    '  void Foo()',
    '  {',
    '    int myVar = 0;',
    '    myVar = myVar + 1;',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/TestRenameComment.script';
  const document = { uri, getText: () => script };

  const occurrences = findAllOccurrencesInDocument(document, 'myVar');
  // Comment line (line 2) should be excluded by sanitization
  const lines = occurrences.map((r) => r.start.line);
  assert.ok(!lines.includes(2), 'Expected no match inside comment');
  assert.equal(occurrences.length, 3, 'Expected 3 occurrences outside of comments');
});

test('rename skips occurrences inside string literals', () => {
  const { findAllOccurrencesInDocument } = loadServerInternals();
  const script = [
    'object TestRenameString : CommandScript',
    '{',
    '  void Foo()',
    '  {',
    '    int token = 0;',
    '    Print("token value");',
    '    token = 1;',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/TestRenameString.script';
  const document = { uri, getText: () => script };

  const occurrences = findAllOccurrencesInDocument(document, 'token');
  const lines = occurrences.map((r) => r.start.line);
  // Line 5 contains "token value" inside a string — must not match
  assert.ok(!lines.includes(5), 'Expected no match inside string literal');
  assert.equal(occurrences.length, 2, 'Expected 2 occurrences outside of strings');
});

test('rename respects function scope: local variables in different functions are independent', () => {
  const { findAllOccurrencesInDocument, parseDocument } = loadServerInternals();
  const script = [
    'object TestRenameScope : CommandScript',
    '{',
    '  void First()',
    '  {',
    '    int value = 1;',
    '    value = value + 1;',
    '  }',
    '',
    '  void Second()',
    '  {',
    '    int value = 2;',
    '    value = value + 2;',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/TestRenameScope.script';
  const document = { uri, getText: () => script };
  const localIndex = parseDocument(script, uri);

  const declarations = localIndex.varDecls.get('value');
  assert.ok(declarations && declarations.length === 2, 'Expected 2 declarations of value');

  // First declaration belongs to First(), second to Second()
  const firstScopeId = declarations[0].scopeId;
  const secondScopeId = declarations[1].scopeId;
  assert.notEqual(firstScopeId, secondScopeId, 'Expected different scopeIds for the two functions');

  const inFirst = findAllOccurrencesInDocument(document, 'value', localIndex, firstScopeId);
  const inSecond = findAllOccurrencesInDocument(document, 'value', localIndex, secondScopeId);

  const firstLines = inFirst.map((r) => r.start.line);
  const secondLines = inSecond.map((r) => r.start.line);

  // First() uses lines 4-5 (0-based), Second() uses lines 10-11
  assert.ok(firstLines.includes(4), 'Expected declaration line of value in First()');
  assert.ok(firstLines.includes(5), 'Expected assignment line in First()');
  assert.ok(!firstLines.includes(10), 'Expected no match in Second() when scoped to First()');
  assert.ok(!firstLines.includes(11), 'Expected no match in Second() when scoped to First()');

  assert.ok(secondLines.includes(10), 'Expected declaration line of value in Second()');
  assert.ok(secondLines.includes(11), 'Expected assignment line in Second()');
  assert.ok(!secondLines.includes(4), 'Expected no match in First() when scoped to Second()');
  assert.ok(!secondLines.includes(5), 'Expected no match in First() when scoped to Second()');
});

test('rename is document-wide for global variables (no scope filtering)', () => {
  const { findAllOccurrencesInDocument, parseDocument } = loadServerInternals();
  const script = [
    'int globalCounter = 0;',
    '',
    'object TestGlobalRename : CommandScript',
    '{',
    '  void Foo()',
    '  {',
    '    globalCounter = globalCounter + 1;',
    '  }',
    '};'
  ].join('\n');
  const uri = 'file:///tmp/TestGlobalRename.script';
  const document = { uri, getText: () => script };
  const localIndex = parseDocument(script, uri);

  const declarations = localIndex.varDecls.get('globalCounter');
  assert.ok(declarations && declarations.length >= 1, 'Expected globalCounter declaration');
  const globalScopeId = declarations[0].scopeId;
  assert.equal(globalScopeId, null, 'Expected global variable scopeId to be null');

  // null scopeId → no scope filter → all occurrences
  const occurrences = findAllOccurrencesInDocument(document, 'globalCounter', localIndex, globalScopeId);
  const lines = occurrences.map((r) => r.start.line);

  assert.ok(lines.includes(0), 'Expected match on global declaration line');
  assert.ok(lines.includes(6), 'Expected match inside function body');
  assert.equal(occurrences.length, 3, 'Expected 3 occurrences of globalCounter');
});
