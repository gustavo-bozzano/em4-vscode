const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const grammarPath = path.resolve(__dirname, '..', 'syntaxes', 'em4script.tmLanguage.json');
const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));

function visitPatterns(patterns, callback, location = 'patterns') {
  for (let index = 0; index < (patterns || []).length; index += 1) {
    const pattern = patterns[index];
    const currentLocation = `${location}[${index}]`;
    callback(pattern, currentLocation);
    visitPatterns(pattern.patterns, callback, `${currentLocation}.patterns`);
  }
}

function findPattern(groupName, patternName) {
  const group = grammar.repository[groupName];
  assert.ok(group, `Missing grammar group: ${groupName}`);
  const pattern = group.patterns.find((candidate) => candidate.name === patternName);
  assert.ok(pattern, `Missing grammar pattern: ${patternName}`);
  return pattern;
}

test('grammar has valid references and JavaScript-compatible regular expressions', () => {
  const repositoryNames = new Set(Object.keys(grammar.repository));
  let regexCount = 0;

  visitPatterns(grammar.patterns, (pattern, location) => {
    if (pattern.include && pattern.include.startsWith('#')) {
      assert.ok(repositoryNames.has(pattern.include.slice(1)), `${location} references ${pattern.include}`);
    }
  }, 'root.patterns');

  for (const [groupName, group] of Object.entries(grammar.repository)) {
    visitPatterns(group.patterns, (pattern, location) => {
      if (pattern.include && pattern.include.startsWith('#')) {
        assert.ok(repositoryNames.has(pattern.include.slice(1)), `${groupName}.${location} references ${pattern.include}`);
      }
      for (const key of ['match', 'begin', 'end', 'while']) {
        if (!pattern[key]) continue;
        assert.doesNotThrow(() => new RegExp(pattern[key], 'u'), `${groupName}.${location}.${key}`);
        regexCount += 1;
      }
    }, `${groupName}.patterns`);
  }

  assert.ok(regexCount >= 50, `Expected broad grammar coverage, got ${regexCount} expressions`);
});

test('every stateful rule has an explicit end or while recovery condition', () => {
  for (const [groupName, group] of Object.entries(grammar.repository)) {
    visitPatterns(group.patterns, (pattern, location) => {
      if (pattern.begin) {
        assert.ok(pattern.end || pattern.while, `${groupName}.${location} can leak into following lines`);
      }
    }, `${groupName}.patterns`);
  }
});

test('unterminated quoted text is confined to its current line', () => {
  for (const name of ['string.quoted.double.em4script', 'string.quoted.single.em4script']) {
    const pattern = findPattern('strings', name);
    assert.match(pattern.end, /\(\?=\$\)/, `${name} must recover at end of line`);
    assert.equal(pattern.applyEndPatternLast, 1, `${name} must let escaped quotes match first`);
  }
});

test('enum state accepts enum bodies but stops before unrelated code', () => {
  const pattern = findPattern('enums', 'meta.enum.declaration.em4script');
  const begin = new RegExp(pattern.begin);
  const continuation = new RegExp(pattern.while);

  assert.ok(begin.test('enum VehicleType'));
  assert.ok(begin.test('enum'));
  assert.ok(continuation.test('{'));
  assert.ok(continuation.test('  TYPE_ENGINE = 1,'));
  assert.ok(continuation.test('  TYPE_TRAILER'));
  assert.equal(continuation.test('};'), false);
  assert.equal(continuation.test('object NextScript : CommandScript'), false);
  assert.equal(continuation.test('void Run()'), false);
});

test('representative EM4 constructs have dedicated scopes', () => {
  const cases = [
    ['preprocessor', 'meta.preprocessor.include.em4script', '#include "Game.script"'],
    ['preprocessor', 'meta.preprocessor.define.em4script', '#define MAX_UNITS 10'],
    ['declarations', 'meta.declaration.inheritance.em4script', 'object Test : CommandScript'],
    ['functionDefinitions', 'meta.function.definition.em4script', 'virtual bool CheckPossible(GameObject *Caller)'],
    ['functionDefinitions', 'meta.function.destructor.em4script', '~Mission16()'],
    ['functionCalls', 'meta.function.call.qualified.em4script', 'Mission::StartCutScene()'],
    ['functionCalls', 'meta.function.call.member.em4script', 'Caller->IsValid()'],
    ['variables', 'meta.variable.declaration.builtin.em4script', 'const char *NAME = "unit";'],
    ['variables', 'meta.variable.declaration.custom.em4script', 'GameObjectList objects;'],
    ['numbers', 'constant.numeric.hex.em4script', '0xFFu'],
    ['numbers', 'constant.numeric.float.em4script', '0.5f']
  ];

  for (const [groupName, patternName, source] of cases) {
    const pattern = findPattern(groupName, patternName);
    assert.match(source, new RegExp(pattern.match), `${patternName} did not match: ${source}`);
  }
});
