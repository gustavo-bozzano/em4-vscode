const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadServerInternals } = require('./serverInternals.js');

test('type validation reports string assigned to float in control-flow bodies', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    float value = "bad";',
        '    int i = 0;',
        '    if (true)',
        '      value = "bad";',
        '    else',
        '      value = "bad";',
        '    while (i < 2)',
        '      value = "bad";',
        '    do',
        '      value = "bad";',
        '    while(false);',
        '    switch(i)',
        '    {',
        '      case 0:',
        '        value = "bad";',
        '        break;',
        '      default:',
        '        value = "bad";',
        '        break;',
        '    }',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestTypeValidation.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message === "Type mismatch: cannot assign 'string' to 'float'");
    assert.equal(mismatchDiagnostics.length, 7, JSON.stringify(diagnostics, null, 2));
});


test('type validation allows assigning int to float', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    float value = 1;',
        '    value = 2;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestTypeValidationNumeric.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message.startsWith('Type mismatch:'));
    assert.equal(mismatchDiagnostics.length, 0, JSON.stringify(diagnostics, null, 2));
});

test('type validation warns when assigning float to int', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    int value = 1;',
        '    value = 1.5;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestTypeValidationFloatToInt.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message.startsWith('Type mismatch:'));
    assert.equal(mismatchDiagnostics.length, 0, JSON.stringify(diagnostics, null, 2));

    const warningDiagnostics = diagnostics.filter((d) => d.message === "Assigning 'float' to 'int' will lose decimal values");
    assert.equal(warningDiagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
});

test('type validation reports single-quoted multi-char text assigned to float', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        "    float teste = 'teste';",
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestTypeValidationSingleQuote.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message === "Type mismatch: cannot assign 'string' to 'float'");
    assert.equal(mismatchDiagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
});

test('type validation reports all primitive mismatches except int to float', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const types = ['bool', 'int', 'float', 'char', 'string'];
    const literalByType = {
        bool: 'true',
        int: '1',
        float: '1.5',
        char: "'a'",
        string: '"txt"'
    };

    const sourceLines = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    bool v_bool = false;',
        '    int v_int = 0;',
        '    float v_float = 0.0;',
        "    char v_char = 'z';",
        '    string v_string = "ok";'
    ];

    for (const expected of types) {
        for (const actual of types) {
            sourceLines.push(`    v_${expected} = ${literalByType[actual]};`);
        }
    }

    sourceLines.push('  }', '};');
    const source = sourceLines.join('\n');
    const uri = 'file:///tmp/TestTypeValidationMatrix.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message.startsWith('Type mismatch:'));

    const expectedMismatchMessages = [];
    for (const expected of types) {
        for (const actual of types) {
            if (expected === actual) continue;
            if (expected === 'float' && actual === 'int') continue;
            if (expected === 'int' && actual === 'float') continue;
            expectedMismatchMessages.push(`Type mismatch: cannot assign '${actual}' to '${expected}'`);
        }
    }

    assert.equal(mismatchDiagnostics.length, expectedMismatchMessages.length, JSON.stringify(diagnostics, null, 2));

    const actualMessages = new Set(mismatchDiagnostics.map((d) => d.message));
    for (const message of expectedMismatchMessages) {
        assert.ok(actualMessages.has(message), `Missing diagnostic: ${message}\n${JSON.stringify(diagnostics, null, 2)}`);
    }
});

test('type validation allows assignments between related classes in both directions', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const source = [
        'class Base',
        '{',
        '};',
        'class Derived : Base',
        '{',
        '};',
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    Base b;',
        '    Derived d;',
        '    b = d;',
        '    d = b;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestClassTypeValidation.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message.startsWith('Type mismatch:'));
    assert.equal(mismatchDiagnostics.length, 0, JSON.stringify(diagnostics, null, 2));
});

test('type validation reports mismatch for unrelated classes', () => {
    const { indexDocument, validateTextDocument, diagnosticsByUri } = loadServerInternals();
    const source = [
        'class Foo',
        '{',
        '};',
        'class Bar',
        '{',
        '};',
        'object TestUnrelated : CommandScript',
        '{',
        '  void Run()',
        '  {',
        '    Foo f;',
        '    Bar b;',
        '    f = b;',
        '  }',
        '};'
    ].join('\n');
    const uri = 'file:///tmp/TestUnrelatedClassTypeValidation.script';
    const doc = { uri, getText: () => source };

    indexDocument(doc);
    validateTextDocument(doc);

    const diagnostics = diagnosticsByUri.get(uri) || [];
    const mismatchDiagnostics = diagnostics.filter((d) => d.message.startsWith('Type mismatch:'));
    assert.equal(mismatchDiagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
    assert.equal(mismatchDiagnostics[0].message, "Type mismatch: cannot assign 'Bar' to 'Foo'");
});