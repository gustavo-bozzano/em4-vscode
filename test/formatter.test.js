const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadServerInternals } = require('./serverInternals.js');

test('formatter preserves CRLF line endings', () => {
    const { formatScriptText } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        'void Foo()',
        '{',
        'return;',
        '}',
        '};'
    ].join('\r\n');

    const formatted = formatScriptText(source, { insertSpaces: true, tabSize: 2 });
    const expected = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    return;',
        '  }',
        '};'
    ].join('\r\n');

    assert.equal(formatted, expected);
});

test('formatter keeps block comment-only lines unchanged', () => {
    const { formatScriptText } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '/*',
        ' * Comment block',
        ' */',
        '    return;',
        '  }',
        '};'
    ].join('\n');

    const formatted = formatScriptText(source, { insertSpaces: true, tabSize: 2 });
    const expected = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '/*',
        ' * Comment block',
        ' */',
        '    return;',
        '  }',
        '};'
    ].join('\n');

    assert.equal(formatted, expected);
});

test('formatter indents if/else bodies without braces', () => {
    const { formatScriptText } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        'void Foo(GameObject *Caller)',
        '{',
        'if (!Caller->IsValid())',
        'return false;',
        'else',
        'return true;',
        '}',
        '};'
    ].join('\n');

    const formatted = formatScriptText(source, { insertSpaces: true, tabSize: 2 });
    const expected = [
        'object Test : CommandScript',
        '{',
        '  void Foo(GameObject *Caller)',
        '  {',
        '    if (!Caller->IsValid())',
        '      return false;',
        '    else',
        '      return true;',
        '  }',
        '};'
    ].join('\n');

    assert.equal(formatted, expected);
});

test('formatter indents braces with spaces', () => {
    const { formatScriptText } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        'void Foo()',
        '{',
        'if(true)',
        '{',
        'return;',
        '}',
        '}',
        '};'
    ].join('\n');

    const formatted = formatScriptText(source, { insertSpaces: true, tabSize: 2 });
    const expected = [
        'object Test : CommandScript',
        '{',
        '  void Foo()',
        '  {',
        '    if(true)',
        '    {',
        '      return;',
        '    }',
        '  }',
        '};'
    ].join('\n');

    assert.equal(formatted, expected);
});

test('formatter can indent with tabs', () => {
    const { formatScriptText } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        'void Foo()',
        '{',
        'return;',
        '}',
        '};'
    ].join('\n');

    const formatted = formatScriptText(source, { insertSpaces: false, tabSize: 4 });
    const expected = [
        'object Test : CommandScript',
        '{',
        '\tvoid Foo()',
        '\t{',
        '\t\treturn;',
        '\t}',
        '};'
    ].join('\n');

    assert.equal(formatted, expected);
});

test('formatter preserves switch/case indentation', () => {
    const { formatScriptText } = loadServerInternals();
    const source = [
        'object Test : CommandScript',
        '{',
        'void Foo(int v)',
        '{',
        'switch(v)',
        '{',
        'case 1:',
        'if(v > 0)',
        'return;',
        'break;',
        'default:',
        'return;',
        '}',
        '}',
        '};'
    ].join('\n');

    const formatted = formatScriptText(source, { insertSpaces: true, tabSize: 2 });
    const expected = [
        'object Test : CommandScript',
        '{',
        '  void Foo(int v)',
        '  {',
        '    switch(v)',
        '    {',
        '      case 1:',
        '        if(v > 0)',
        '          return;',
        '        break;',
        '      default:',
        '        return;',
        '    }',
        '  }',
        '};'
    ].join('\n');

    assert.equal(formatted, expected);
});