const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  DiagnosticSeverity,
  CompletionItemKind,
  SymbolKind,
  SymbolInformation,
  MarkupKind,
  Location,
  Range
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const SCRIPT_SOURCE = "em4-script"

const KEYWORDS = [
  'namespace', 'class', 'enum', 'struct', 'union', 'object', 'const',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'return', 'break', 'continue', 'true', 'false', 'new', 'delete',
  'virtual', 'static', 'void', 'bool', 'int', 'float', 'char'
];
const RESERVED_IDENTIFIERS = new Set(KEYWORDS);

const BUILTIN_TYPES = new Set([
  'void', 'bool', 'int', 'float', 'char', 'unsigned', 'signed'
]);

const sdkByName = new Map();
const sdkMembersByOwner = new Map();
const sdkBaseByType = new Map();
const sdkEnumMembersByType = new Map();
const sdkKnownOwners = new Set();
const sdkKnownTypes = new Set([...BUILTIN_TYPES]);
const PRIMITIVE_ASSIGNMENT_TYPES = new Set(['bool', 'int', 'float', 'char', 'string']);

const documentIndexes = new Map();

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch (err) {
    connection.console.warn(`Failed to convert URI to path: ${uri} (${err.message})`);
    return null;
  }
}

function pathToUri(filePath) {
  return pathToFileURL(filePath).toString();
}

function wordAt(document, position) {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const line = lines[position.line] || '';
  const left = line.slice(0, position.character);
  const right = line.slice(position.character);
  const leftMatch = left.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const rightMatch = right.match(/^[A-Za-z0-9_]*/);
  const l = leftMatch ? leftMatch[0] : '';
  const r = rightMatch ? rightMatch[0] : '';
  return l + r;
}

function wordRangeAt(document, position) {
  const lines = document.getText().split(/\r?\n/);
  const line = lines[position.line] || '';
  const left = line.slice(0, position.character);
  const right = line.slice(position.character);
  const leftMatch = left.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const rightMatch = right.match(/^[A-Za-z0-9_]*/);
  const leftWord = leftMatch ? leftMatch[0] : '';
  const rightWord = rightMatch ? rightMatch[0] : '';
  const token = leftWord + rightWord;
  if (!token) return null;
  const start = position.character - leftWord.length;
  return {
    token,
    start,
    end: start + token.length
  };
}

function createDefinition(uri, line, character, detail, kind, documentation, owner) {
  return {
    uri,
    line,
    character,
    detail,
    kind,
    documentation: documentation || '',
    owner: owner || null
  };
}

function ensureMapEntry(map, key) {
  if (!map.has(key)) {
    map.set(key, new Map());
  }
  return map.get(key);
}

function addSdkDefinition(name, def) {
  if (!name) return;
  if (!sdkByName.has(name)) {
    sdkByName.set(name, def);
  }
  if (def.owner) {
    const ownerMembers = ensureMapEntry(sdkMembersByOwner, def.owner);
    if (!ownerMembers.has(name)) {
      ownerMembers.set(name, def);
    }
  }
}

function stripCommentPrefix(line) {
  return line.replace(/^\s*\/\/\s?/, '').trim();
}

function stripBlockCommentPrefix(line) {
  return line
    .replace(/^\s*\/\*\*?\s?/, '')
    .replace(/\s*\*\/\s*$/, '')
    .replace(/^\s*\*\s?/, '')
    .trim();
}

function addVarDeclaration(varDecls, varName, typeName, line, scopeId, character) {
  if (!varName || !typeName) return;
  if (!varDecls.has(varName)) {
    varDecls.set(varName, []);
  }
  varDecls.get(varName).push({
    type: typeName,
    line,
    scopeId: scopeId || null,
    character: Number.isInteger(character) ? character : 0
  });
}

function parseParamsAndCollectVars(paramText, varDecls, line, scopeId, lineText) {
  const params = extractParamDefinitions(paramText);
  for (const param of params) {
    const typeName = param.type;
    const varName = param.name;
    const character = lineText ? findParameterNameOffset(lineText, varName) : -1;
    addVarDeclaration(varDecls, varName, typeName, line, scopeId, character);
  }
}

function findParameterNameOffset(signatureLine, paramName) {
  if (!signatureLine || !paramName) return -1;

  const openIndex = signatureLine.indexOf('(');
  if (openIndex < 0) return signatureLine.indexOf(paramName);

  const closeIndex = findMatchingParenIndex(signatureLine, openIndex);
  if (closeIndex < 0) return signatureLine.indexOf(paramName, openIndex + 1);

  const paramList = signatureLine.slice(openIndex + 1, closeIndex);
  const namePattern = new RegExp(`(^|[^A-Za-z0-9_])${paramName}([^A-Za-z0-9_]|$)`);
  const match = paramList.match(namePattern);
  if (!match || match.index === undefined) {
    return signatureLine.indexOf(paramName, openIndex + 1);
  }

  const leadingPart = match[0].match(/^[^A-Za-z0-9_]*/);
  const leadingSize = leadingPart ? leadingPart[0].length : 0;
  return openIndex + 1 + match.index + leadingSize;
}

function extractParamDefinitions(paramText) {
  const params = (paramText || '').split(',').map((p) => p.trim()).filter(Boolean);
  const result = [];
  for (const param of params) {
    const m = param.match(/((?:(?:const|volatile|static|signed|unsigned)\s+)*[A-Za-z_][A-Za-z0-9_:<>]*)\s*([*&]+)?\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*=.*)?$/);
    if (!m) continue;
    const baseType = normalizeTypeName(m[1]) || m[1];
    const pointerPart = m[2] || '';
    const mappedType = (baseType === 'char' && pointerPart) ? 'string' : baseType;
    result.push({ type: mappedType, name: m[3] });
  }
  return result;
}

function parseStatementVariableDeclarations(statement, varDecls, line, scopeId) {
  if (!statement) return;
  const forMatch = statement.match(/\bfor\s*\(([^;]*);/);
  const normalized = forMatch ? `${forMatch[1]};` : statement;
  const parts = normalized.split(';');
  const CONTROL_KEYWORDS = new Set(['if', 'else', 'switch', 'while', 'do', 'return', 'case', 'default']);
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const branchDecl = text.match(/^(?:if|else\s+if)\s*\([^)]*\)\s+(.+)$/);
    if (branchDecl) {
      parseStatementVariableDeclarations(`${branchDecl[1]};`, varDecls, line, scopeId);
      continue;
    }

    const ctorDecl = text.match(/^([A-Za-z_][A-Za-z0-9_:<>]*)\s+[*&\s]*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/);
    if (ctorDecl) {
      if ((ctorDecl[3] || '').trim().length > 0) {
        addVarDeclaration(varDecls, ctorDecl[2], ctorDecl[1], line, scopeId, statement.indexOf(ctorDecl[2]));
      }
      continue;
    }

    const plainDecl = text.match(/^((?:(?:const|volatile|static|signed|unsigned)\s+)*[A-Za-z_][A-Za-z0-9_:<>]*)\s+(.+)$/);
    if (!plainDecl) continue;
    if (CONTROL_KEYWORDS.has(plainDecl[1])) continue;
    if (plainDecl[2].trim().startsWith('=')) continue;

    const typeName = normalizeTypeName(plainDecl[1]) || plainDecl[1];
    const declarators = plainDecl[2].split(',').map((d) => d.trim()).filter(Boolean);
    for (const declarator of declarators) {
      const withoutInit = declarator.split('=')[0].trim();
      const withoutArray = withoutInit.replace(/\[[^\]]*\]/g, '').trim();
      const nameMatch = withoutArray.match(/^(?:[*&]\s*)*([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!nameMatch) continue;
      const pointerPrefix = (withoutInit.match(/^[*&]+/) || [''])[0];
      const mappedType = (typeName === 'char' && pointerPrefix) ? 'string' : typeName;
      addVarDeclaration(varDecls, nameMatch[1], mappedType, line, scopeId, statement.indexOf(nameMatch[1]));
    }
  }
}

function parseFunctionSignature(signatureText) {
  const functionPattern = /^\s*(?:(?:virtual|static|inline)\s+)*([A-Za-z_][A-Za-z0-9_:*&<>]*(?:\s+[A-Za-z_][A-Za-z0-9_:*&<>]*)*)\s+([*&\s]*)([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*\(([^)]*)\)\s*(?:\b(?:const|override|final)\b\s*)*/;
  const ctorPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:\b(?:const|override|final)\b\s*)*/;

  const fn = signatureText.match(functionPattern);
  if (fn) {
    const qualifiedName = fn[3];
    const simpleName = qualifiedName.includes('::')
      ? qualifiedName.split('::')[qualifiedName.split('::').length - 1]
      : qualifiedName;
    if (RESERVED_IDENTIFIERS.has(simpleName)) return null;
    const pointerPart = fn[2] || '';
    const returnType = `${fn[1]}${pointerPart}`.trim();
    return { returnType, name: simpleName, params: fn[4] || '' };
  }

  const ctor = signatureText.match(ctorPattern);
  if (ctor) {
    if (RESERVED_IDENTIFIERS.has(ctor[1])) return null;
    return { returnType: '', name: ctor[1], params: ctor[2] || '' };
  }

  return null;
}

function parseMemberFieldDeclarations(statement, owner, uri, line, membersByOwner) {
  if (!owner || !statement) return;
  const text = statement.trim();
  if (!text || text.includes('(')) return;
  if (/^(public|private|protected)\s*:/.test(text)) return;

  const memberDecl = text.match(/^(?:(?:static|const)\s+)*(?:(?:class|struct|union|object)\s+)?([A-Za-z_][A-Za-z0-9_:<>]*)\s+(.+?)\s*;?$/);
  if (!memberDecl) return;

  const typeName = memberDecl[1];
  const declarators = memberDecl[2].split(',').map((d) => d.trim()).filter(Boolean);
  for (const declarator of declarators) {
    const withoutInit = declarator.split('=')[0].trim();
    const withoutArray = withoutInit.replace(/\[[^\]]*\]/g, '').trim();
    const nameMatch = withoutArray.match(/^(?:[*&]\s*)*([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const character = Math.max(0, statement.indexOf(name));
    const detail = `${typeName} ${name}`;
    const def = createDefinition(uri, line, character, detail, SymbolKind.Constant, '', owner);
    ensureMapEntry(membersByOwner, owner).set(name, def);
  }
}

function parseBaseTypes(baseClause) {
  if (!baseClause) return [];
  const deny = new Set(['public', 'private', 'protected', 'virtual', 'class', 'struct', 'union', 'object']);
  const result = [];
  const parts = baseClause.split(',');
  for (const part of parts) {
    const tokens = (part.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((t) => !deny.has(t));
    if (tokens.length) {
      result.push(tokens[tokens.length - 1]);
    }
  }
  return result;
}

function sanitizeLineStateful(line, state, options) {
  const maskStrings = !(options && options.preserveStringContent);
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    if (state.inLineComment) {
      out += ' ';
      continue;
    }

    if (state.inBlockComment) {
      if (ch === '*' && next === '/') {
        out += '  ';
        state.inBlockComment = false;
        i += 1;
      } else {
        out += ' ';
      }
      continue;
    }

    if (state.inString) {
      if (ch === '\\' && next) {
        out += maskStrings ? '  ' : `${ch}${next}`;
        i += 1;
      } else if (ch === '"') {
        out += '"';
        state.inString = false;
      } else {
        out += maskStrings ? ' ' : ch;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      state.inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      state.inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      out += '"';
      state.inString = true;
      continue;
    }

    out += ch;
  }

  state.inLineComment = false;
  return out;
}

function sanitizeLinesForAnalysis(text) {
  const lines = text.split(/\r?\n/);
  const state = { inLineComment: false, inBlockComment: false, inString: false };
  return lines.map((line) => sanitizeLineStateful(line, state));
}

function sanitizeLinesForValidation(text) {
  const lines = text.split(/\r?\n/);
  const state = { inLineComment: false, inBlockComment: false, inString: false };
  return lines.map((line) => sanitizeLineStateful(line, state, { preserveStringContent: true }));
}

function findMatchingParenIndex(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function introducesSingleStatementIndent(sanitizedTrimmedLine) {
  const text = (sanitizedTrimmedLine || '').trim();
  if (!text) return false;

  const parseConditionControl = (controlText, keyword) => {
    if (!controlText.startsWith(keyword)) return false;
    const parenIndex = controlText.indexOf('(');
    if (parenIndex < 0) return false;
    const closeIndex = findMatchingParenIndex(controlText, parenIndex);
    if (closeIndex < 0) return false;
    const trailing = controlText.slice(closeIndex + 1).trim();
    return trailing.length === 0;
  };

  if (parseConditionControl(text, 'if')) return true;
  if (parseConditionControl(text, 'for')) return true;
  if (parseConditionControl(text, 'while')) return true;

  if (text.startsWith('else')) {
    const rest = text.slice('else'.length).trim();
    if (!rest) return true;
    if (parseConditionControl(rest, 'if')) return true;
    return false;
  }

  if (text.startsWith('do')) {
    const rest = text.slice('do'.length).trim();
    return rest.length === 0;
  }

  return false;
}

function formatScriptText(text, options) {
  const lines = text.split(/\r?\n/);
  const sanitizedLines = sanitizeLinesForAnalysis(text);
  const useSpaces = options ? options.insertSpaces !== false : true;
  const tabSize = options && Number.isInteger(options.tabSize) && options.tabSize > 0 ? options.tabSize : 2;
  const indentUnit = useSpaces ? ' '.repeat(tabSize) : '\t';
  let depth = 0;
  let pendingSingleStatementIndent = 0;
  let caseBodyIndentDepth = null;

  const formatted = lines.map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    const sanitizedLine = sanitizedLines[index] || '';
    if (sanitizedLine.trim().length === 0) {
      return line;
    }

    const sanitizedTrimmed = sanitizedLine.trimStart();
    let leadingClosers = 0;
    while (leadingClosers < sanitizedTrimmed.length && sanitizedTrimmed[leadingClosers] === '}') {
      leadingClosers += 1;
    }

    const structuralDepth = Math.max(0, depth - leadingClosers);
    const isCaseLabel = /^default\s*:|^case\b[\s\S]*:/.test(sanitizedTrimmed);
    let caseBodyOffset = 0;
    if (!isCaseLabel && caseBodyIndentDepth !== null) {
      if (structuralDepth >= caseBodyIndentDepth) {
        caseBodyOffset = 1;
      } else {
        caseBodyIndentDepth = null;
      }
    }

    const opensStandaloneBlock = sanitizedTrimmed.startsWith('{');
    const singleStatementOffset = opensStandaloneBlock && pendingSingleStatementIndent > 0
      ? pendingSingleStatementIndent - 1
      : pendingSingleStatementIndent;
    const lineDepth = Math.max(0, structuralDepth + singleStatementOffset + caseBodyOffset);
    const indented = `${indentUnit.repeat(lineDepth)}${trimmed}`;

    if (pendingSingleStatementIndent > 0) {
      pendingSingleStatementIndent -= 1;
    }

    const opens = (sanitizedLine.match(/\{/g) || []).length;
    const closes = (sanitizedLine.match(/\}/g) || []).length;
    depth = Math.max(0, depth + opens - closes);

    if (introducesSingleStatementIndent(sanitizedTrimmed)) {
      pendingSingleStatementIndent += 1;
    }
    if (isCaseLabel) {
      caseBodyIndentDepth = structuralDepth;
    } else if (caseBodyIndentDepth !== null && depth < caseBodyIndentDepth) {
      caseBodyIndentDepth = null;
    }

    return indented;
  });

  const firstLineBreak = text.match(/\r\n|\n|\r/);
  const lineEnding = firstLineBreak ? firstLineBreak[0] : '\n';
  return formatted.join(lineEnding);
}

function parseDocument(text, uri) {
  const lines = text.split(/\r?\n/);
  const sanitizedLines = sanitizeLinesForAnalysis(text);
  const definitions = new Map();
  const symbols = [];
  const membersByOwner = new Map();
  const baseByType = new Map();
  const enumMembersByType = new Map();
  const knownOwners = new Set();
  const knownTypes = new Set([...BUILTIN_TYPES]);
  const varDecls = new Map();
  const lineFunctionIds = [];
  const lineTypeOwners = [];
  const functionContexts = [];
  let nextFunctionId = 1;

  const contexts = [];
  let pendingContext = null;
  let pendingEnum = null;
  const enumContexts = [];
  let braceDepth = 0;
  let docBuffer = [];
  let pendingMultiLineDecl = null;

  const namespacePattern = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const classLikePattern = /^\s*(class|struct|union|object)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^/{]+))?/;
  const enumPattern = /^\s*enum(?:\s+([A-Za-z_][A-Za-z0-9_]*))?/;
  const constPattern = /^\s*const\s+[A-Za-z_][A-Za-z0-9_\s\*]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\[\])?\s*=/;
  let pendingFunction = null;

  function currentOwner() {
    for (let i = contexts.length - 1; i >= 0; i -= 1) {
      if (contexts[i].kind === 'type' || contexts[i].kind === 'namespace') {
        return contexts[i].name;
      }
    }
    return null;
  }

  function captureStart(lineText, matchValue, captureValue) {
    const base = matchValue.indexOf(captureValue);
    if (base < 0) return Math.max(0, lineText.indexOf(captureValue));
    const start = lineText.indexOf(matchValue);
    if (start < 0) return Math.max(0, lineText.indexOf(captureValue));
    return start + base;
  }

  function addDefinition(name, def, symbolKind) {
    if (!definitions.has(name)) {
      definitions.set(name, def);
    }
    symbols.push(SymbolInformation.create(
      name,
      symbolKind,
      Range.create(def.line, def.character, def.line, def.character + name.length),
      def.uri
    ));
  }

  function maybeActivatePendingContext(lineText) {
    if (pendingContext && lineText.includes('{')) {
      contexts.push({
        kind: pendingContext.kind,
        name: pendingContext.name,
        depth: braceDepth + 1
      });
      pendingContext = null;
    }
  }

  function maybeActivatePendingEnum(lineText) {
    if (pendingEnum && lineText.includes('{')) {
      enumContexts.push({
        name: pendingEnum.name || null,
        isAnonymous: !pendingEnum.name,
        depth: braceDepth + 1
      });
      pendingEnum = null;
    }
  }

  function popContexts() {
    while (contexts.length && braceDepth < contexts[contexts.length - 1].depth) {
      contexts.pop();
    }
  }

  function popFunctionContexts() {
    while (functionContexts.length && braceDepth < functionContexts[functionContexts.length - 1].depth) {
      functionContexts.pop();
    }
  }

  function popEnumContexts() {
    while (enumContexts.length && braceDepth < enumContexts[enumContexts.length - 1].depth) {
      enumContexts.pop();
    }
  }

  function currentFunctionId() {
    if (!functionContexts.length) return null;
    return functionContexts[functionContexts.length - 1].id;
  }

  function currentTypeOwner() {
    for (let i = contexts.length - 1; i >= 0; i -= 1) {
      if (contexts[i].kind === 'type') {
        return contexts[i].name;
      }
    }
    return null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    const analysisLine = sanitizedLines[i] || '';
    const trimmed = lineText.trim();
    const analysisTrimmed = analysisLine.trim();

    maybeActivatePendingContext(analysisLine);
    maybeActivatePendingEnum(analysisLine);
    lineFunctionIds[i] = currentFunctionId();
    lineTypeOwners[i] = currentTypeOwner();

    if (!trimmed) {
      docBuffer = [];
    } else if (trimmed.startsWith('/*')) {
      const blockLines = [];
      let blockEndLine = i;
      for (let j = i; j < lines.length; j += 1) {
        const blockLine = lines[j].trim();
        const text = stripBlockCommentPrefix(blockLine);
        if (text) {
          blockLines.push(text);
        }
        blockEndLine = j;
        if (blockLine.includes('*/')) {
          break;
        }
      }
      if (blockLines.length) {
        docBuffer.push(...blockLines);
      }
      i = blockEndLine;
    } else if (trimmed.startsWith('//')) {
      docBuffer.push(stripCommentPrefix(trimmed));
    } else {
      if (!analysisTrimmed) {
        continue;
      }
      const documentation = docBuffer.join('\n').trim();
      const namespaceMatch = analysisLine.match(namespacePattern);
      if (namespaceMatch) {
        const name = namespaceMatch[1];
        const character = captureStart(analysisLine, namespaceMatch[0], name);
        const detail = trimmed;
        const def = createDefinition(uri, i, character, detail, SymbolKind.Namespace, documentation, null);
        addDefinition(name, def, SymbolKind.Namespace);
        knownOwners.add(name);
        if (analysisLine.includes('{')) {
          contexts.push({ kind: 'namespace', name, depth: braceDepth + 1 });
        } else {
          pendingContext = { kind: 'namespace', name };
        }
      }

      const classLikeMatch = analysisLine.match(classLikePattern);
      if (classLikeMatch) {
        const name = classLikeMatch[2];
        const character = captureStart(analysisLine, classLikeMatch[0], name);
        const detail = trimmed;
        const kind = SymbolKind.Class;
        const owner = currentOwner();
        const def = createDefinition(uri, i, character, detail, kind, documentation, owner);
        addDefinition(name, def, kind);
        knownOwners.add(name);
        knownTypes.add(name);
        if (owner) {
          ensureMapEntry(membersByOwner, owner).set(name, def);
        }
        const baseTypes = parseBaseTypes(classLikeMatch[3] || '');
        if (baseTypes.length) {
          baseByType.set(name, baseTypes);
          for (const baseType of baseTypes) {
            knownTypes.add(baseType);
          }
        }
        if (analysisLine.includes('{')) {
          contexts.push({ kind: 'type', name, depth: braceDepth + 1 });
        } else {
          pendingContext = { kind: 'type', name };
        }
      }

      const enumMatch = analysisLine.match(enumPattern);
      if (enumMatch) {
        const name = enumMatch[1] || null;
        const owner = currentOwner();
        if (name) {
          const character = captureStart(analysisLine, enumMatch[0], name);
          const def = createDefinition(uri, i, character, trimmed, SymbolKind.Enum, documentation, owner);
          addDefinition(name, def, SymbolKind.Enum);
          knownTypes.add(name);
          if (owner) {
            ensureMapEntry(membersByOwner, owner).set(name, def);
          }
          if (!enumMembersByType.has(name)) {
            enumMembersByType.set(name, new Map());
          }
        }
        if (analysisLine.includes('{')) {
          enumContexts.push({ name, isAnonymous: !name, depth: braceDepth + 1 });
        } else {
          pendingEnum = { name };
        }
      }

      if (enumContexts.length) {
        const currentEnum = enumContexts[enumContexts.length - 1];
        const enumName = currentEnum.name;
        const enumItemMatch = analysisTrimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[^,}]+)?\s*,?\s*$/);
        if (enumItemMatch) {
          const memberName = enumItemMatch[1];
          const character = captureStart(analysisLine, analysisTrimmed, memberName);
          const detail = enumName ? `${enumName} ${memberName}` : `enum ${memberName}`;
          const def = createDefinition(uri, i, character, detail, SymbolKind.Constant, documentation, enumName || null);
          addDefinition(memberName, def, SymbolKind.Constant);
          if (enumName) {
            ensureMapEntry(enumMembersByType, enumName).set(memberName, def);
            ensureMapEntry(membersByOwner, enumName).set(memberName, def);
          }
        }
      }

      const constMatch = analysisLine.match(constPattern);
      if (constMatch) {
        const name = constMatch[1];
        const character = captureStart(analysisLine, constMatch[0], name);
        const owner = currentOwner();
        const def = createDefinition(uri, i, character, trimmed, SymbolKind.Constant, documentation, owner);
        addDefinition(name, def, SymbolKind.Constant);
        if (owner) {
          ensureMapEntry(membersByOwner, owner).set(name, def);
        }
      }

      const insideFunction = currentFunctionId() !== null;
      if (insideFunction) {
        pendingFunction = null;
      } else {
        if (pendingFunction) {
          pendingFunction.signature = `${pendingFunction.signature} ${analysisTrimmed}`.trim();
        } else if (analysisTrimmed.includes('(')) {
          pendingFunction = {
            line: i,
            sourceLine: lines[i] || '',
            signature: analysisTrimmed
          };
        }

        const functionReady = pendingFunction && pendingFunction.signature.includes(')') && (analysisTrimmed.includes(';') || analysisTrimmed.includes('{') || analysisTrimmed.includes('}'));
        if (functionReady) {
          const parsedFunction = parseFunctionSignature(pendingFunction.signature);
          if (parsedFunction) {
            const owner = currentOwner();
            const returnType = parsedFunction.returnType;
            const name = parsedFunction.name;
            if (!returnType && owner && name !== owner) {
              // Inside a type scope, signatures without return type are only valid for constructors;
              // this prevents regular call expressions (e.g. SetIcon(...);) from being indexed as methods.
              pendingFunction = null;
              continue;
            }
            const params = parsedFunction.params;
            const character = captureStart(pendingFunction.sourceLine, pendingFunction.sourceLine, name);
            const functionLine = pendingFunction.line;
            const detail = returnType ? `${returnType} ${name}(${params})` : `${name}(${params})`;
            const def = createDefinition(uri, functionLine, character, detail, SymbolKind.Function, documentation, owner);

            if (!definitions.has(name)) {
              definitions.set(name, def);
            }
            symbols.push(SymbolInformation.create(
              name,
              SymbolKind.Function,
              Range.create(functionLine, character, functionLine, character + name.length),
              uri
            ));

            if (owner) {
              ensureMapEntry(membersByOwner, owner).set(name, def);
            }

            const isFunctionDefinition = analysisTrimmed.includes('{') && !analysisTrimmed.includes(';');
            if (isFunctionDefinition) {
              const scopeId = nextFunctionId;
              nextFunctionId += 1;
              functionContexts.push({ id: scopeId, depth: braceDepth + 1 });
              lineFunctionIds[i] = scopeId;
              parseParamsAndCollectVars(params, varDecls, functionLine, scopeId, pendingFunction.sourceLine);
            }
          }
          pendingFunction = null;
        }
      }

      if (pendingMultiLineDecl && !insideFunction) {
        const reconstructed = `${pendingMultiLineDecl.type} ${analysisTrimmed}`;
        parseStatementVariableDeclarations(reconstructed, varDecls, i, null);
        const owner = currentOwner();
        if (analysisTrimmed.endsWith(';') || analysisTrimmed.includes('{')) {
          if (owner && analysisTrimmed.endsWith(';')) {
            parseMemberFieldDeclarations(reconstructed.replace(/;+\s*$/, ''), owner, uri, i, membersByOwner);
          }
          pendingMultiLineDecl = null;
        }
      } else {
        parseStatementVariableDeclarations(analysisLine, varDecls, i, lineFunctionIds[i]);
        const owner = currentOwner();
        if (owner && analysisTrimmed.endsWith(';')) {
          parseMemberFieldDeclarations(analysisTrimmed.replace(/;+\s*$/, ''), owner, uri, i, membersByOwner);
        }
        if (!insideFunction && currentOwner() && analysisTrimmed.endsWith(',') && !analysisTrimmed.includes('(')) {
          const typeDecl = analysisTrimmed.match(/^(?:(?:const|volatile|static|signed|unsigned)\s+)*([A-Za-z_][A-Za-z0-9_:<>]*)\s+/);
          if (typeDecl && !RESERVED_IDENTIFIERS.has(typeDecl[1])) {
            pendingMultiLineDecl = { type: typeDecl[1] };
          }
        }
      }
      if (insideFunction) {
        pendingMultiLineDecl = null;
      }

      docBuffer = [];
    }

    const stripped = analysisLine;
    const opens = (stripped.match(/\{/g) || []).length;
    const closes = (stripped.match(/\}/g) || []).length;
    braceDepth += opens - closes;
    popContexts();
    popFunctionContexts();
    popEnumContexts();
  }

  return { definitions, symbols, membersByOwner, baseByType, enumMembersByType, knownOwners, knownTypes, varDecls, lineFunctionIds, lineTypeOwners, lines };
}

function indexDocument(document) {
  const parsed = parseDocument(document.getText(), document.uri);
  documentIndexes.set(document.uri, parsed);
}

function loadSdk(workspaceFolders) {
  sdkByName.clear();
  sdkMembersByOwner.clear();
  sdkBaseByType.clear();
  sdkEnumMembersByType.clear();
  sdkKnownOwners.clear();
  sdkKnownTypes.clear();
  for (const t of BUILTIN_TYPES) {
    sdkKnownTypes.add(t);
  }

  const sdkDirs = [];
  for (const folder of workspaceFolders || []) {
    const basePath = uriToPath(folder.uri);
    if (!basePath) continue;
    const sdkDir = path.join(basePath, 'EM4 sdk');
    if (fs.existsSync(sdkDir)) {
      sdkDirs.push(sdkDir);
    }
  }

  if (loadSdk.bundledSdkPath && fs.existsSync(loadSdk.bundledSdkPath)) {
    sdkDirs.push(loadSdk.bundledSdkPath);
  }

  for (const sdkDir of sdkDirs) {
    const files = fs.readdirSync(sdkDir).filter((f) => f.toLowerCase().endsWith('.script'));
    for (const file of files) {
      const fullPath = path.join(sdkDir, file);
      const uri = pathToUri(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = parseDocument(content, uri);

      for (const owner of parsed.knownOwners) {
        sdkKnownOwners.add(owner);
      }
      for (const typeName of parsed.knownTypes) {
        sdkKnownTypes.add(typeName);
      }
      for (const [typeName, baseTypes] of parsed.baseByType.entries()) {
        if (!sdkBaseByType.has(typeName)) {
          sdkBaseByType.set(typeName, baseTypes);
        }
      }
      for (const [enumName, enumMembers] of parsed.enumMembersByType.entries()) {
        const target = ensureMapEntry(sdkEnumMembersByType, enumName);
        for (const [memberName, memberDef] of enumMembers.entries()) {
          if (!target.has(memberName)) {
            target.set(memberName, memberDef);
          }
        }
      }

      for (const [name, def] of parsed.definitions.entries()) {
        addSdkDefinition(name, def);
      }

      for (const [owner, members] of parsed.membersByOwner.entries()) {
        const target = ensureMapEntry(sdkMembersByOwner, owner);
        for (const [memberName, memberDef] of members.entries()) {
          if (!target.has(memberName)) {
            target.set(memberName, memberDef);
          }
        }
      }
    }
  }
}

loadSdk.bundledSdkPath = null;

function resolveOwnerType(localIndex, ownerToken, lineNumber) {
  if (!ownerToken) return null;
  if (localIndex && localIndex.varDecls && localIndex.varDecls.has(ownerToken)) {
    const declarations = localIndex.varDecls.get(ownerToken);
    const lineFunctionId = (localIndex.lineFunctionIds && Number.isInteger(lineNumber)) ? (localIndex.lineFunctionIds[lineNumber] || null) : null;
    if (Number.isInteger(lineNumber)) {
      const declarationsBeforeLine = [];
      for (let i = declarations.length - 1; i >= 0; i -= 1) {
        if (declarations[i].line > lineNumber) {
          continue;
        }
        declarationsBeforeLine.push(declarations[i]);
        const declarationScopeId = declarations[i].scopeId || null;
        const sameFunction = declarationScopeId === lineFunctionId;
        const globalDecl = declarationScopeId === null;
        if (sameFunction || globalDecl) {
          return declarations[i].type;
        }
      }
      if (declarationsBeforeLine.length === 1) {
        // Fallback for single prior declaration: when scope ID matching fails but only one same-name
        // declaration exists before this line, use it to avoid false negatives from incomplete scope mapping.
        // Ambiguous multi-declaration cases are still rejected.
        return declarationsBeforeLine[0].type;
      }
      return null;
    }
    if (declarations.length) {
      return declarations[declarations.length - 1].type;
    }
  }
  if (localIndex && localIndex.knownOwners.has(ownerToken)) {
    return ownerToken;
  }
  if (sdkKnownOwners.has(ownerToken)) {
    return ownerToken;
  }
  if (sdkKnownTypes.has(ownerToken)) {
    return ownerToken;
  }
  return null;
}

function getBaseTypes(localIndex, owner) {
  if (localIndex && localIndex.baseByType && localIndex.baseByType.has(owner)) {
    return localIndex.baseByType.get(owner);
  }
  if (sdkBaseByType.has(owner)) {
    return sdkBaseByType.get(owner);
  }
  return [];
}

function getOwnerCandidates(owner) {
  if (!owner) return [];
  const candidates = [owner];
  if (owner.includes('::')) {
    const unqualified = owner.split('::').pop();
    if (unqualified && unqualified !== owner) {
      candidates.push(unqualified);
    }
  }
  return candidates;
}

function collectMembersForOwner(localIndex, owner) {
  const merged = new Map();
  const queue = getOwnerCandidates(owner);
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    if (localIndex && localIndex.membersByOwner.has(current)) {
      for (const [name, def] of localIndex.membersByOwner.get(current).entries()) {
        if (!merged.has(name)) {
          merged.set(name, def);
        }
      }
    }

    if (sdkMembersByOwner.has(current)) {
      for (const [name, def] of sdkMembersByOwner.get(current).entries()) {
        if (!merged.has(name)) {
          merged.set(name, def);
        }
      }
    }

    const baseTypes = getBaseTypes(localIndex, current);
    for (const baseType of baseTypes) {
      if (!visited.has(baseType)) {
        queue.push(baseType);
      }
    }
  }

  return merged;
}

function getMemberDefinition(localIndex, owner, memberName) {
  if (!owner || !memberName) return null;
  const members = collectMembersForOwner(localIndex, owner);
  if (members.has(memberName)) {
    return members.get(memberName);
  }
  return null;
}

function resolveMemberDefinitionAtPosition(document, localIndex, position, memberName) {
  if (!document || !memberName) return null;
  const context = getContextAtPosition(document, position);
  if (context && context.ownerToken) {
    const ownerType = resolveOwnerType(localIndex, context.ownerToken, position.line);
    if (ownerType) {
      const memberDef = getMemberDefinition(localIndex, ownerType, memberName);
      if (memberDef) {
        return memberDef;
      }
    }
  }

  const implicitOwner = (localIndex && localIndex.lineTypeOwners) ? (localIndex.lineTypeOwners[position.line] || null) : null;
  if (implicitOwner) {
    const memberDef = getMemberDefinition(localIndex, implicitOwner, memberName);
    if (memberDef) {
      return memberDef;
    }
  }

  return null;
}

function getClosestDeclaration(declarations, line, character, scopeIdFilter) {
  let best = null;
  for (const declaration of declarations) {
    if (declaration.line > line) continue;
    if (scopeIdFilter !== undefined && declaration.scopeId !== scopeIdFilter) continue;
    const declarationCharacter = Number.isInteger(declaration.character) ? declaration.character : 0;
    if (declaration.line === line && declarationCharacter > character) continue;

    if (!best) {
      best = declaration;
      continue;
    }
    const bestCharacter = Number.isInteger(best.character) ? best.character : 0;
    if (declaration.line > best.line || (declaration.line === best.line && declarationCharacter > bestCharacter)) {
      best = declaration;
    }
  }
  return best;
}

function resolveVariableDefinitionAtPosition(localIndex, position, token) {
  if (!localIndex || !token || !localIndex.varDecls || !localIndex.varDecls.has(token)) {
    return null;
  }

  const declarations = localIndex.varDecls.get(token);
  if (!declarations || !declarations.length) return null;

  const lineFunctionId = (localIndex.lineFunctionIds && Number.isInteger(position.line))
    ? (localIndex.lineFunctionIds[position.line] || null)
    : null;

  const localDecl = lineFunctionId !== null
    ? getClosestDeclaration(declarations, position.line, position.character, lineFunctionId)
    : null;
  const globalDecl = getClosestDeclaration(declarations, position.line, position.character, null);
  const declaration = localDecl || globalDecl;
  if (!declaration) return null;

  return createDefinition(
    '',
    declaration.line,
    declaration.character,
    `${declaration.type} ${token}`,
    SymbolKind.Constant,
    '',
    null
  );
}

function resolveDefinitionAtPosition(document, localIndex, position) {
  if (!document) return null;
  const rangeInfo = wordRangeAt(document, position);
  if (!rangeInfo) return null;

  const memberDef = resolveMemberDefinitionAtPosition(document, localIndex, position, rangeInfo.token);
  if (memberDef) {
    return Location.create(
      memberDef.uri,
      Range.create(memberDef.line, memberDef.character, memberDef.line, memberDef.character + rangeInfo.token.length)
    );
  }

  const variableDef = resolveVariableDefinitionAtPosition(localIndex, position, rangeInfo.token);
  if (variableDef) {
    return Location.create(
      document.uri,
      Range.create(variableDef.line, variableDef.character, variableDef.line, variableDef.character + rangeInfo.token.length)
    );
  }

  if (localIndex && localIndex.definitions.has(rangeInfo.token)) {
    const def = localIndex.definitions.get(rangeInfo.token);
    return Location.create(def.uri, Range.create(def.line, def.character, def.line, def.character + rangeInfo.token.length));
  }

  if (sdkByName.has(rangeInfo.token)) {
    const sdk = sdkByName.get(rangeInfo.token);
    return Location.create(sdk.uri, Range.create(sdk.line, sdk.character, sdk.line, sdk.character + rangeInfo.token.length));
  }

  return null;
}

function getContextAtPosition(document, position) {
  const lines = document.getText().split(/\r?\n/);
  const line = lines[position.line] || '';
  const before = line.slice(0, position.character);
  const after = line.slice(position.character);

  const completionMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (completionMatch) {
    return {
      ownerToken: completionMatch[1],
      operator: completionMatch[2],
      memberPrefix: completionMatch[3] || ''
    };
  }

  const leftWord = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const rightWord = after.match(/^[A-Za-z0-9_]*/);
  const token = `${leftWord ? leftWord[0] : ''}${rightWord ? rightWord[0] : ''}`;
  if (!token) return null;

  const tokenStart = position.character - (leftWord ? leftWord[0].length : 0);
  const ownerMatch = line.slice(0, tokenStart).match(/([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*$/);

  return {
    token,
    ownerToken: ownerMatch ? ownerMatch[1] : null,
    operator: ownerMatch ? ownerMatch[2] : null,
    memberPrefix: token
  };
}

function getCallContextAtPosition(document, position) {
  const lines = document.getText().split(/\r?\n/);
  const line = lines[position.line] || '';
  const before = line.slice(0, position.character);
  const stack = [];

  for (let i = 0; i < before.length; i += 1) {
    const ch = before[i];
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')' && stack.length) {
      stack.pop();
    }
  }

  if (!stack.length) return null;
  const openParenIndex = stack[stack.length - 1];
  const calleePrefix = before.slice(0, openParenIndex).trimEnd();
  const memberMatch = calleePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)$/);
  const functionMatch = calleePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!memberMatch && !functionMatch) return null;

  const argumentText = before.slice(openParenIndex + 1);
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let argIndex = 0;
  for (let i = 0; i < argumentText.length; i += 1) {
    const ch = argumentText[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) argIndex += 1;
  }

  return {
    ownerToken: memberMatch ? memberMatch[1] : null,
    methodName: memberMatch ? memberMatch[3] : null,
    functionName: functionMatch ? functionMatch[1] : null,
    argIndex
  };
}

function collectEnumMembersByType(localIndex, enumType) {
  const merged = new Map();
  if (localIndex && localIndex.enumMembersByType && localIndex.enumMembersByType.has(enumType)) {
    for (const [name, def] of localIndex.enumMembersByType.get(enumType).entries()) {
      merged.set(name, def);
    }
  }
  if (sdkEnumMembersByType.has(enumType)) {
    for (const [name, def] of sdkEnumMembersByType.get(enumType).entries()) {
      if (!merged.has(name)) {
        merged.set(name, def);
      }
    }
  }
  return merged;
}

function getEnumCompletionItemsForCall(document, localIndex, position) {
  const callContext = getCallContextAtPosition(document, position);
  if (!callContext) return [];

  let functionDef = null;
  if (callContext.ownerToken && callContext.methodName) {
    const ownerType = resolveOwnerType(localIndex, callContext.ownerToken, position.line);
    if (ownerType) {
      functionDef = getMemberDefinition(localIndex, ownerType, callContext.methodName);
    }
  } else if (callContext.functionName) {
    if (localIndex && localIndex.definitions.has(callContext.functionName)) {
      functionDef = localIndex.definitions.get(callContext.functionName);
    } else if (sdkByName.has(callContext.functionName)) {
      functionDef = sdkByName.get(callContext.functionName);
    }
  }

  if (!functionDef || functionDef.kind !== SymbolKind.Function) {
    return [];
  }

  const parsed = parseFunctionSignature(functionDef.detail);
  if (!parsed) return [];
  const params = extractParamDefinitions(parsed.params || '');
  if (callContext.argIndex < 0 || callContext.argIndex >= params.length) return [];

  const expectedType = params[callContext.argIndex].type;
  const enumMembers = collectEnumMembersByType(localIndex, expectedType);
  const items = [];
  const enumMemberKind = Object.prototype.hasOwnProperty.call(CompletionItemKind, 'EnumMember')
    ? CompletionItemKind.EnumMember
    : (CompletionItemKind.Constant || CompletionItemKind.Field);
  for (const [name, def] of enumMembers.entries()) {
    items.push({
      label: name,
      kind: enumMemberKind,
      detail: `${expectedType} value`,
      documentation: def.documentation || undefined
    });
  }
  return items;
}

function normalizeTypeName(typeName) {
  if (!typeName) return null;
  const cleaned = String(typeName)
    .replace(/\b(const|volatile|static|signed|unsigned)\b/g, ' ')
    .replace(/[*&]/g, ' ')
    .trim();
  const match = cleaned.match(/^([A-Za-z_][A-Za-z0-9_:<>]*)/);
  return match ? match[1] : null;
}

function getDefinitionValueType(def) {
  if (!def || !def.detail) return null;
  if (def.kind === SymbolKind.Function) {
    const parsed = parseFunctionSignature(def.detail);
    if (!parsed) return null;
    const returnTypeText = parsed.returnType || '';
    const normalizedReturnType = normalizeTypeName(returnTypeText);
    const nameIndex = def.detail.indexOf(parsed.name);
    const prefix = nameIndex >= 0 ? def.detail.slice(0, nameIndex) : '';
    if (normalizedReturnType === 'char' && /char\s*[*&]\s*$/i.test(prefix.trim())) {
      return 'string';
    }
    return normalizedReturnType;
  }
  const match = def.detail.match(/^\s*([A-Za-z_][A-Za-z0-9_:<>]*)/);
  return normalizeTypeName(match ? match[1] : null);
}

function resolveFunctionReturnType(localIndex, functionName) {
  if (!functionName) return null;
  let fnDef = null;
  if (localIndex && localIndex.definitions && localIndex.definitions.has(functionName)) {
    fnDef = localIndex.definitions.get(functionName);
  } else if (sdkByName.has(functionName)) {
    fnDef = sdkByName.get(functionName);
  }
  if (!fnDef || fnDef.kind !== SymbolKind.Function) return null;
  return getDefinitionValueType(fnDef);
}

function inferExpressionType(expression, localIndex, lineNumber) {
  let text = (expression || '').trim();
  if (!text) return null;

  while (text.startsWith('(') && text.endsWith(')')) {
    const closeIndex = findMatchingParenIndex(text, 0);
    if (closeIndex !== text.length - 1) break;
    text = text.slice(1, -1).trim();
  }

  const doubleQuoted = text.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (doubleQuoted) {
    const content = doubleQuoted[1];
    if (/^[-+]?(?:0x[0-9a-fA-F]+|\d+)$/.test(content)) return 'int';
    if (/^[-+]?(?:(?:\d+\.\d*|\d*\.\d+)(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)f?$/i.test(content)) return 'float';
    return 'string';
  }
  const singleQuoted = text.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (singleQuoted) {
    const content = singleQuoted[1];
    if (content.length === 1 || /^\\./.test(content)) {
      return 'char';
    }
    return 'string';
  }
  if (/^(true|false)$/.test(text)) return 'bool';
  if (/^[-+]?(?:(?:\d+\.\d*|\d*\.\d+)(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)f?$/i.test(text)) return 'float';
  if (/^[-+]?(?:0x[0-9a-fA-F]+|\d+)$/.test(text)) return 'int';

  const unaryMatch = text.match(/^[!+\-~]\s*(.+)$/);
  if (unaryMatch) {
    return inferExpressionType(unaryMatch[1], localIndex, lineNumber);
  }

  const hasMemberChain = /(?:->|::|\.)[\s\S]*(?:->|::|\.)/.test(text);
  if (hasMemberChain) {
    const simpleMemberAccess = /^([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)$/.test(text);
    const simpleMemberCall = /^([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*\)$/.test(text);
    if (!simpleMemberAccess && !simpleMemberCall) {
      return null;
    }
  }

  const memberCall = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*\)$/);
  if (memberCall) {
    const ownerType = resolveOwnerType(localIndex, memberCall[1], lineNumber);
    if (!ownerType) return null;
    const memberDef = getMemberDefinition(localIndex, ownerType, memberCall[3]);
    return getDefinitionValueType(memberDef);
  }

  const functionCall = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)$/);
  if (functionCall) {
    return resolveFunctionReturnType(localIndex, functionCall[1]);
  }

  const memberAccess = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)$/);
  if (memberAccess) {
    const ownerType = resolveOwnerType(localIndex, memberAccess[1], lineNumber);
    if (!ownerType) return null;
    const memberDef = getMemberDefinition(localIndex, ownerType, memberAccess[3]);
    return getDefinitionValueType(memberDef);
  }

  const arrayAccess = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\[[^\]]*\]$/);
  if (arrayAccess) {
    return normalizeTypeName(resolveOwnerType(localIndex, arrayAccess[1], lineNumber));
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return normalizeTypeName(resolveOwnerType(localIndex, text, lineNumber));
  }

  return null;
}

function resolveAssignmentTargetType(localIndex, lhs, lineNumber) {
  let text = (lhs || '').trim();
  if (!text) return null;
  const hadArraySuffix = /\[[^\]]*\]/.test(text);
  text = text.replace(/\[[^\]]*\]/g, '').trim();
  text = text.replace(/^\*+/, '').trim();

  const declarationMatch = text.match(/^((?:[A-Za-z_][A-Za-z0-9_:<>]*\s+)+(?:[*&]\s*)*)([A-Za-z_][A-Za-z0-9_]*)$/);
  if (declarationMatch) {
    const declarationTypeText = declarationMatch[1];
    const declarationName = declarationMatch[2];
    const normalizedDeclarationType = normalizeTypeName(declarationTypeText);
    if (normalizedDeclarationType === 'char' && (/[*&]/.test(declarationTypeText) || hadArraySuffix)) {
      return 'string';
    }
    text = declarationName;
  }

  const memberAccess = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)$/);
  if (memberAccess) {
    const ownerType = resolveOwnerType(localIndex, memberAccess[1], lineNumber);
    if (!ownerType) return null;
    const memberDef = getMemberDefinition(localIndex, ownerType, memberAccess[3]);
    return getDefinitionValueType(memberDef);
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    const varType = normalizeTypeName(resolveOwnerType(localIndex, text, lineNumber));
    if (varType) return varType;

    const implicitOwner = (localIndex && localIndex.lineTypeOwners) ? (localIndex.lineTypeOwners[lineNumber] || null) : null;
    if (implicitOwner) {
      const memberDef = getMemberDefinition(localIndex, implicitOwner, text);
      return getDefinitionValueType(memberDef);
    }
  }

  return null;
}

function isDeclarationAssignmentTarget(lhs) {
  const text = (lhs || '').trim();
  if (!text) return false;
  return /^((?:[A-Za-z_][A-Za-z0-9_:<>]*\s+)+(?:[*&]\s*)*)([A-Za-z_][A-Za-z0-9_]*)$/.test(text);
}

function isTypeAssignmentCompatible(localIndex, expectedType, actualType) {
  const expected = normalizeTypeName(expectedType);
  const actual = normalizeTypeName(actualType);
  if (!expected || !actual) return true;
  if (expected === actual) return true;

  const expectedIsPrimitive = PRIMITIVE_ASSIGNMENT_TYPES.has(expected);
  const actualIsPrimitive = PRIMITIVE_ASSIGNMENT_TYPES.has(actual);

  if (expectedIsPrimitive || actualIsPrimitive) {
    if (!expectedIsPrimitive || !actualIsPrimitive) {
      // Allow assigning int to enum types (EM4 script is C-like: enums are int-compatible)
      if (actual === 'int' && !expectedIsPrimitive) {
        const expectedIsEnum = (localIndex && localIndex.enumMembersByType && localIndex.enumMembersByType.has(expected))
          || sdkEnumMembersByType.has(expected);
        if (expectedIsEnum) return true;
      }
      return false;
    }
    if (expected === 'float' && actual === 'int') return true;
    return false;
  }

  return isTypeInInheritanceChain(localIndex, actual, expected)
    || isTypeInInheritanceChain(localIndex, expected, actual);
}

function isTypeInInheritanceChain(localIndex, typeName, expectedBaseType) {
  if (!typeName || !expectedBaseType) return false;
  if (typeName === expectedBaseType) return true;

  const queue = [typeName];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const baseTypes = getBaseTypes(localIndex, current);
    for (const baseType of baseTypes) {
      if (baseType === expectedBaseType) return true;
      if (!visited.has(baseType)) queue.push(baseType);
    }
  }
  return false;
}

function splitTopLevelStatements(lineText) {
  const parts = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;

  for (let i = 0; i < lineText.length; i += 1) {
    const ch = lineText[i];
    const next = i + 1 < lineText.length ? lineText[i + 1] : '';
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const segment = lineText.slice(start, i).trim();
      if (segment) {
        parts.push({ text: segment, offset: start + lineText.slice(start, i).indexOf(segment) });
      }
      start = i + 1;
    }
  }

  const rest = lineText.slice(start).trim();
  if (rest) {
    parts.push({ text: rest, offset: start + lineText.slice(start).indexOf(rest) });
  }
  return parts;
}

function collectAssignmentsFromStatement(statement, statementOffset) {
  const text = (statement || '').trim();
  if (!text) return [];
  const offset = Number.isInteger(statementOffset) ? statementOffset + statement.indexOf(text) : 0;

  const branchMatch = text.match(/^(?:if|else\s+if|while)\s*\([^)]*\)\s+(.+)$/);
  if (branchMatch) {
    const branchOffset = offset + text.indexOf(branchMatch[1]);
    return collectAssignmentsFromStatement(branchMatch[1], branchOffset);
  }

  const elseMatch = text.match(/^else\s+(.+)$/);
  if (elseMatch) {
    const elseOffset = offset + text.indexOf(elseMatch[1]);
    return collectAssignmentsFromStatement(elseMatch[1], elseOffset);
  }

  const doWhileMatch = text.match(/^do\s+(.+)\s+while\s*\([^)]*\)\s*$/);
  if (doWhileMatch) {
    const doOffset = offset + text.indexOf(doWhileMatch[1]);
    return collectAssignmentsFromStatement(doWhileMatch[1], doOffset);
  }

  const results = [];
  const assignmentRegex = /([+\-*/%]?=)/g;
  let match;
  while ((match = assignmentRegex.exec(text)) !== null) {
    const op = match[1];
    const idx = match.index;
    const prev = idx > 0 ? text[idx - 1] : '';
    const next = idx + op.length < text.length ? text[idx + op.length] : '';
    if (op === '=' && (prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=')) {
      continue;
    }

    const lhsRaw = text.slice(0, idx).trim();
    const rhs = text.slice(idx + op.length).trim();
    if (!lhsRaw || !rhs) continue;
    if (/^(return|case|default)\b/.test(lhsRaw)) continue;

    const declarationLhs = lhsRaw.match(/(?:[A-Za-z_][A-Za-z0-9_:<>]*\s+)+(?:[*&]\s*)*([A-Za-z_][A-Za-z0-9_]*)$/);
    const lhs = lhsRaw;
    const lhsLocalIndex = declarationLhs
      ? lhsRaw.lastIndexOf(lhs)
      : lhsRaw.indexOf(lhs);

    results.push({
      lhs,
      rhs,
      lhsOffset: offset + lhsLocalIndex,
      operator: op
    });
    break;
  }
  return results;
}

function findPreviousMeaningfulLine(lines, lineIndex) {
  for (let i = lineIndex - 1; i >= 0; i -= 1) {
    const trimmed = (lines[i] || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function findNextMeaningfulLine(lines, lineIndex) {
  for (let i = lineIndex + 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function getLineExpressionDepths(lines) {
  let parenDepth = 0;
  let bracketDepth = 0;
  return lines.map((line) => {
    const startParenDepth = parenDepth;
    const startBracketDepth = bracketDepth;
    let inString = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inString) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '(') parenDepth += 1;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === '[') bracketDepth += 1;
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    }

    return {
      startsWithinExpression: startParenDepth > 0 || startBracketDepth > 0,
      endsWithinExpression: parenDepth > 0 || bracketDepth > 0
    };
  });
}

function getEnumLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  const enumPattern = /^\s*enum\b(?:\s+[A-Za-z_][A-Za-z0-9_]*)?/;
  let braceDepth = 0;
  let pendingEnum = false;
  let enumDepth = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const trimmed = line.trim();

    if (!pendingEnum && enumPattern.test(trimmed)) {
      if (line.includes('{')) {
        enumDepth = braceDepth + 1;
      } else {
        pendingEnum = true;
      }
    } else if (pendingEnum && line.includes('{')) {
      enumDepth = braceDepth + 1;
      pendingEnum = false;
    }

    if (enumDepth !== null && braceDepth >= enumDepth) {
      flags[i] = true;
    }

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    braceDepth += opens - closes;

    if (enumDepth !== null && braceDepth < enumDepth) {
      enumDepth = null;
    }
  }

  return flags;
}

function lineRequiresTrailingSemicolon(lineText, previousLineText, nextLineText, depthInfo) {
  const trimmed = (lineText || '').trim();
  if (!trimmed) return false;
  if (trimmed.endsWith(';')) return false;
  if (trimmed.endsWith(',')) return false;
  if (depthInfo && (depthInfo.startsWithinExpression || depthInfo.endsWithinExpression)) return false;
  if (/^[{}]$/.test(trimmed)) return false;
  if (/^(case\b.*|default)\s*:\s*$/.test(trimmed)) return false;
  if (/^(if|else\s+if|for|switch)\s*\(.*\)\s*$/.test(trimmed)) return false;
  if (/^(else|do)\b/.test(trimmed)) return false;
  if (/^while\s*\(.*\)\s*$/.test(trimmed)) {
    return /^(do\b|})/.test((previousLineText || '').trim());
  }
  if (trimmed.endsWith('{') || trimmed.endsWith('}')) return false;
  if ((nextLineText || '').trim().startsWith('{')) return false;
  if (/^}\s*else(?:\s+if\s*\(.*\))?$/.test(trimmed)) return false;

  const normalizedStatement = trimmed.replace(/^}\s*/, '').trim();
  if (collectAssignmentsFromStatement(normalizedStatement, 0).length > 0) return true;
  if (/^(return|break|continue|delete)\b/.test(normalizedStatement)) return true;
  if (/^(?:\+\+|--)\s*[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedStatement)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*(?:\+\+|--)$/.test(normalizedStatement)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\s*(?:->|\.|::)\s*[A-Za-z_][A-Za-z0-9_]*)*\s*\(.*\)$/.test(normalizedStatement)) {
    return true;
  }
  if (/^((?:(?:const|volatile|static|signed|unsigned)\s+)*[A-Za-z_][A-Za-z0-9_:<>]*)\s+.+$/.test(normalizedStatement)) {
    return true;
  }
  return false;
}

function buildCompletionItems(document, localIndex, position) {
  if (!document) return [];
  const context = getContextAtPosition(document, position);
  const items = [];
  const seenLabels = new Set();
  const pushItem = (item) => {
    if (!item || !item.label || seenLabels.has(item.label)) return;
    seenLabels.add(item.label);
    items.push(item);
  };

  if (context && context.ownerToken) {
    const ownerType = resolveOwnerType(localIndex, context.ownerToken, position.line);
    if (ownerType) {
      const mergedMembers = collectMembersForOwner(localIndex, ownerType);

      const prefix = context.memberPrefix || '';
      for (const [name, def] of mergedMembers.entries()) {
        if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) {
          continue;
        }
        items.push({
          label: name,
          kind: def.kind === SymbolKind.Function ? CompletionItemKind.Method : CompletionItemKind.Field,
          detail: def.detail,
          documentation: def.documentation || undefined
        });
      }
      return items;
    }
  }

  const implicitOwner = (localIndex && localIndex.lineTypeOwners) ? (localIndex.lineTypeOwners[position.line] || null) : null;
  if (implicitOwner) {
    const mergedMembers = collectMembersForOwner(localIndex, implicitOwner);
    const prefix = context?.token || '';
    for (const [name, def] of mergedMembers.entries()) {
      if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) {
        continue;
      }
      pushItem({
        label: name,
        kind: def.kind === SymbolKind.Function ? CompletionItemKind.Method : CompletionItemKind.Field,
        detail: def.detail,
        documentation: def.documentation || undefined
      });
    }
  }

  const enumItems = getEnumCompletionItemsForCall(document, localIndex, position);
  for (const item of enumItems) {
    pushItem(item);
  }

  for (const keyword of KEYWORDS) {
    pushItem({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      detail: 'EM4 Script keyword'
    });
  }

  for (const [name, def] of sdkByName.entries()) {
    pushItem({
      label: name,
      kind: def.kind === SymbolKind.Function ? CompletionItemKind.Function : CompletionItemKind.Reference,
      detail: def.detail,
      documentation: def.documentation || undefined
    });
  }

  if (localIndex) {
    for (const [name, def] of localIndex.definitions.entries()) {
      pushItem({
        label: name,
        kind: def.kind === SymbolKind.Function ? CompletionItemKind.Function : CompletionItemKind.Reference,
        detail: def.detail,
        documentation: def.documentation || undefined
      });
    }
  }

  return items;
}

function formatHover(def) {
  const parts = [`\`\`\`em4script\n${def.detail}\n\`\`\``];
  if (def.documentation) {
    parts.push(def.documentation);
  }
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: parts.join('\n\n')
    }
  };
}

function findAllOccurrencesInDocument(document, token, localIndex, scopeId) {
  if (!document || !token) return [];
  const sanitizedLines = sanitizeLinesForAnalysis(document.getText());
  const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const locations = [];
  const filterByScope = localIndex && scopeId !== undefined && scopeId !== null;

  for (let i = 0; i < sanitizedLines.length; i += 1) {
    if (filterByScope) {
      const lineFnId = (localIndex.lineFunctionIds && localIndex.lineFunctionIds[i]) || null;
      if (lineFnId !== scopeId) continue;
    }
    const sanitized = sanitizedLines[i];
    let match;
    while ((match = pattern.exec(sanitized)) !== null) {
      locations.push(Range.create(i, match.index, i, match.index + token.length));
    }
  }

  return locations;
}

function validateTextDocument(document) {
  const text = document.getText();
  const diagnostics = [];
  const stack = [];

  const localIndex = documentIndexes.get(document.uri);
  const opening = new Map([
    ['{', '}'],
    ['[', ']']
  ]);
  const closing = new Map([
    ['}', '{'],
    [']', '[']
  ]);

  let line = 0;
  let character = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (ch === '\n') {
      line += 1;
      character = 0;
      inLineComment = false;
      continue;
    }

    if (inLineComment) {
      character += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
        character += 2;
      } else {
        character += 1;
      }
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        i += 1;
        character += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      character += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      character += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      character += 2;
      continue;
    }

    if (ch === '"') {
      inString = true;
      character += 1;
      continue;
    }

    if (opening.has(ch)) {
      stack.push({ ch, line, character });
    } else if (closing.has(ch)) {
      const expectedOpen = closing.get(ch);
      const top = stack.length ? stack[stack.length - 1] : null;
      if (!top || top.ch !== expectedOpen) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: Range.create(line, character, line, character + 1),
          message: `Delimiter '${ch}' has no matching pair`,
          source: SCRIPT_SOURCE
        });
      } else {
        stack.pop();
      }
    }

    character += 1;
  }

  for (const entry of stack) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: Range.create(entry.line, entry.character, entry.line, entry.character + 1),
      message: `Delimiter '${entry.ch}' is not closed`,
      source: SCRIPT_SOURCE
    });
  }

  const analysisLines = sanitizeLinesForAnalysis(text);
  const validationLines = sanitizeLinesForValidation(text);
  const lineDepths = getLineExpressionDepths(validationLines);
  const enumLineFlags = getEnumLineFlags(analysisLines);
  for (let i = 0; i < analysisLines.length; i += 1) {
    const sanitized = analysisLines[i];
    const validationLine = validationLines[i] || '';

    if (!enumLineFlags[i] && lineRequiresTrailingSemicolon(
      validationLine,
      findPreviousMeaningfulLine(validationLines, i),
      findNextMeaningfulLine(validationLines, i),
      lineDepths[i]
    )) {
      const trimmed = validationLine.trimEnd();
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: Range.create(i, trimmed.length, i, trimmed.length),
        message: "Missing ';' at end of line",
        source: SCRIPT_SOURCE
      });
    }

    const memberAccess = /([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)/g;
    let match;
    while ((match = memberAccess.exec(sanitized)) !== null) {
      const ownerToken = match[1];
      const memberName = match[3];
      const ownerType = resolveOwnerType(localIndex, ownerToken, i);

      if (!ownerType) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: Range.create(i, match.index, i, match.index + ownerToken.length),
          message: `Identifier '${ownerToken}' is not declared`,
          source: SCRIPT_SOURCE
        });
        continue;
      }

      const memberDef = getMemberDefinition(localIndex, ownerType, memberName);
      if (!memberDef) {
        const memberPos = sanitized.indexOf(memberName, match.index);
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: Range.create(i, memberPos, i, memberPos + memberName.length),
          message: `Member '${memberName}' was not found on '${ownerType}'`,
          source: SCRIPT_SOURCE
        });
      }
    }

    const statements = splitTopLevelStatements(validationLine);
    for (const statement of statements) {
      const assignments = collectAssignmentsFromStatement(statement.text, statement.offset);
      for (const assignment of assignments) {
        const expectedType = resolveAssignmentTargetType(localIndex, assignment.lhs, i);
        const actualType = inferExpressionType(assignment.rhs, localIndex, i);
        if (!expectedType || !actualType) continue;
        const normExpected = normalizeTypeName(expectedType) || expectedType;
        const normActual = normalizeTypeName(actualType) || actualType;

        // Special-case: assigning `float` to `int` is allowed, but warn about decimal loss.
        if (normExpected === 'int' && normActual === 'float') {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: Range.create(i, assignment.lhsOffset, i, assignment.lhsOffset + assignment.lhs.length),
            message: `Assigning 'float' to 'int' will lose decimal values`,
            source: SCRIPT_SOURCE
          });
          // allow the assignment (no error)
          continue;
        }
        const declarationTarget = isDeclarationAssignmentTarget(assignment.lhs);
        const expectedPrimitive = PRIMITIVE_ASSIGNMENT_TYPES.has(normExpected);
        const actualPrimitive = PRIMITIVE_ASSIGNMENT_TYPES.has(normActual);
        if (declarationTarget && !expectedPrimitive && !actualPrimitive) continue;

        if (isTypeAssignmentCompatible(localIndex, expectedType, actualType)) continue;

        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: Range.create(i, assignment.lhsOffset, i, assignment.lhsOffset + assignment.lhs.length),
          message: `Type mismatch: cannot assign '${actualType}' to '${expectedType}'`,
          source: SCRIPT_SOURCE
        });
      }
    }
  }

  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

connection.onInitialize((params) => {
  const options = params.initializationOptions || {};
  if (options.bundledSdkPath) {
    loadSdk.bundledSdkPath = options.bundledSdkPath;
  }
  loadSdk(params.workspaceFolders || []);

  return {
    capabilities: {
      textDocumentSync: documents.syncKind,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['.', '>', ':']
      },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      renameProvider: { prepareProvider: true }
    }
  };
});

connection.onInitialized(() => {
  for (const doc of documents.all()) {
    indexDocument(doc);
    validateTextDocument(doc);
  }
});

documents.onDidOpen((event) => {
  indexDocument(event.document);
  validateTextDocument(event.document);
});

documents.onDidChangeContent((change) => {
  indexDocument(change.document);
  validateTextDocument(change.document);
});

documents.onDidClose((event) => {
  documentIndexes.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  const localIndex = documentIndexes.get(params.textDocument.uri);
  return buildCompletionItems(document, localIndex, params.position);
});

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const localIndex = documentIndexes.get(document.uri);
  const rangeInfo = wordRangeAt(document, params.position);
  if (!rangeInfo) return null;

  const memberDef = resolveMemberDefinitionAtPosition(document, localIndex, params.position, rangeInfo.token);
  if (memberDef) {
    return formatHover(memberDef);
  }

  if (localIndex && localIndex.definitions.has(rangeInfo.token)) {
    return formatHover(localIndex.definitions.get(rangeInfo.token));
  }

  if (sdkByName.has(rangeInfo.token)) {
    return formatHover(sdkByName.get(rangeInfo.token));
  }

  return null;
});

connection.onDefinition((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const localIndex = documentIndexes.get(document.uri);
  return resolveDefinitionAtPosition(document, localIndex, params.position);
});

connection.onDocumentSymbol((params) => {
  const indexed = documentIndexes.get(params.textDocument.uri);
  if (!indexed) {
    return [];
  }

  return indexed.symbols;
});

connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const text = document.getText();
  const formatted = formatScriptText(text, params.options || {});
  if (formatted === text) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const lastLineIndex = Math.max(0, lines.length - 1);
  const lastLineLength = lines[lastLineIndex] ? lines[lastLineIndex].length : 0;

  return [{
    range: Range.create(0, 0, lastLineIndex, lastLineLength),
    newText: formatted
  }];
});

connection.onPrepareRename((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const rangeInfo = wordRangeAt(document, params.position);
  if (!rangeInfo || !rangeInfo.token) return null;

  if (RESERVED_IDENTIFIERS.has(rangeInfo.token)) return null;

  return {
    range: Range.create(params.position.line, rangeInfo.start, params.position.line, rangeInfo.end),
    placeholder: rangeInfo.token
  };
});

connection.onRenameRequest((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const rangeInfo = wordRangeAt(document, params.position);
  if (!rangeInfo || !rangeInfo.token) return null;

  const newName = (params.newName || '').trim();
  if (!newName || newName === rangeInfo.token) return null;
  if (RESERVED_IDENTIFIERS.has(rangeInfo.token)) return null;

  const localIndex = documentIndexes.get(params.textDocument.uri);

  // Determine the scope of the symbol under the cursor.
  // If it is a function-local variable (scopeId is a number), only rename
  // occurrences on lines that belong to that same function scope.
  // For globals (scopeId === null) or non-variable symbols (scopeId === undefined)
  // the search is document-wide (no scope filter applied).
  let scopeId;
  if (localIndex && localIndex.varDecls && localIndex.varDecls.has(rangeInfo.token)) {
    const declarations = localIndex.varDecls.get(rangeInfo.token);
    const lineFunctionId = (localIndex.lineFunctionIds && localIndex.lineFunctionIds[params.position.line]) || null;
    const best = (lineFunctionId !== null
      ? getClosestDeclaration(declarations, params.position.line, params.position.character, lineFunctionId)
      : null) || getClosestDeclaration(declarations, params.position.line, params.position.character, null);
    if (best) {
      scopeId = best.scopeId;
    }
  }

  const occurrences = findAllOccurrencesInDocument(document, rangeInfo.token, localIndex, scopeId);
  if (!occurrences.length) return null;

  const edits = occurrences.map((range) => ({ range, newText: newName }));

  return {
    changes: {
      [document.uri]: edits
    }
  };
});

documents.listen(connection);
connection.listen();
