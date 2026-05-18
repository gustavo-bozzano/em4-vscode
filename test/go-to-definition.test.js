const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadServerInternals } = require('./serverInternals.js');


test('go to definition resolves inherited base methods without explicit owner', () => {
    const { loadSdk, parseDocument, resolveDefinitionAtPosition } = loadServerInternals();
    const sdkPath = path.resolve(__dirname, '..', 'sdk');
    loadSdk.bundledSdkPath = sdkPath;
    loadSdk([]);

    const script = [
        'object TestCmd : CommandScript',
        '{',
        '  TestCmd()',
        '  {',
        '    SetIcon("deinstall");',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestInheritedDefinition.script';
    const document = { uri, getText: () => script };
    const localIndex = parseDocument(script, uri);
    const position = { line: 4, character: '    SetIcon'.length - 1 };
    const location = resolveDefinitionAtPosition(document, localIndex, position);

    assert.ok(location, 'Expected go-to-definition location for inherited method');
    assert.notEqual(location.args[0], uri, 'Expected inherited method definition outside local test file');
});

test('go to definition resolves method parameter variables', () => {
    const { parseDocument, resolveDefinitionAtPosition } = loadServerInternals();
    const script = [
        'object TestParam : CommandScript',
        '{',
        '  void Foo(int amount)',
        '  {',
        '    amount = amount + 1;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestParamDefinition.script';
    const document = { uri, getText: () => script };
    const localIndex = parseDocument(script, uri);
    const position = { line: 4, character: '    amount = amou'.length };
    const location = resolveDefinitionAtPosition(document, localIndex, position);

    assert.ok(location, 'Expected go-to-definition location for parameter');
    assert.equal(location.args[0], uri, 'Expected parameter definition in same document');
    assert.equal(location.args[1].args[0], 2, 'Expected parameter declaration line');
});

test('go to definition resolves parameter when method name contains parameter substring', () => {
    const { parseDocument, resolveDefinitionAtPosition } = loadServerInternals();
    const signature = '  bool CheckTarget(GameObject *Caller, Actor *Target, int childID)';
    const expectedTargetColumn = signature.indexOf('Actor *Target') + 'Actor *'.length;
    const script = [
        'object TestParamOverlap : CommandScript',
        '{',
        signature,
        '  {',
        '    if(!Target->IsValid())',
        '      return false;',
        '    return true;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestParamOverlapDefinition.script';
    const document = { uri, getText: () => script };
    const localIndex = parseDocument(script, uri);
    const position = { line: 4, character: '    if(!Target->'.length - 2 };
    const location = resolveDefinitionAtPosition(document, localIndex, position);

    assert.ok(location, 'Expected go-to-definition location for overlapping parameter name');
    assert.equal(location.args[0], uri, 'Expected overlapping parameter definition in same document');
    assert.equal(location.args[1].args[0], 2, 'Expected overlapping parameter declaration line');
    assert.equal(location.args[1].args[1], expectedTargetColumn, 'Expected overlapping parameter declaration column');
});

test('go to definition prefers local scope variable over same name from other scope', () => {
    const { parseDocument, resolveDefinitionAtPosition } = loadServerInternals();
    const script = [
        'object TestScope : CommandScript',
        '{',
        '  void First()',
        '  {',
        '    int value = 1;',
        '  }',
        '',
        '  void Second()',
        '  {',
        '    int value = 2;',
        '    value = value + 1;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestScopeDefinition.script';
    const document = { uri, getText: () => script };
    const localIndex = parseDocument(script, uri);
    const position = { line: 10, character: '    value = valu'.length };
    const location = resolveDefinitionAtPosition(document, localIndex, position);

    assert.ok(location, 'Expected go-to-definition location for scoped variable');
    assert.equal(location.args[0], uri, 'Expected scoped variable definition in same document');
    assert.equal(location.args[1].args[0], 9, 'Expected declaration from current function scope');
});

test('go to definition does not leak constructor-style local variable across methods', () => {
    const { parseDocument, resolveDefinitionAtPosition } = loadServerInternals();
    const script = [
        'object TestScopeCtorStyle : CommandScript',
        '{',
        '  bool CheckPossible(GameObject *Caller)',
        '  {',
        '    Person p(Caller);',
        '    if(p.IsValid())',
        '      return true;',
        '    return false;',
        '  }',
        '',
        '  void PushActions(GameObject *Caller, Actor *Target, int childID)',
        '  {',
        '    Person p(Caller);',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestScopeCtorStyleDefinition.script';
    const document = { uri, getText: () => script };
    const localIndex = parseDocument(script, uri);
    const position = { line: 5, character: '    if(p'.length - 1 };
    const location = resolveDefinitionAtPosition(document, localIndex, position);

    assert.ok(location, 'Expected go-to-definition location for constructor-style local variable');
    assert.equal(location.args[0], uri, 'Expected local variable definition in same document');
    assert.equal(location.args[1].args[0], 4, 'Expected declaration from CheckPossible scope');
});