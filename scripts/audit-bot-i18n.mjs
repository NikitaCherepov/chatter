#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const CYRILLIC = /[А-Яа-яЁё]/u;

function printHelp() {
  console.log(`Usage:
  npm run i18n:audit:bot
  npm run i18n:audit:bot:all

Options:
  --source <file>      TypeScript source (default: index.ts)
  --all                Print internal logs in addition to USER and REVIEW findings
  --json               Print machine-readable JSON
  --fail-on <level>    user, review, or none (default: user)
  --help               Show this help

USER means a Cyrillic literal can flow into a Telegram reply, button, callback
answer, or media caption. REVIEW means it is outside a proven Telegram path but
may affect errors, stored data, or AI prompts. INTERNAL covers console output.
Comments are counted separately.`);
}

function parseArgs(argv) {
  const args = { source: 'index.ts', all: false, json: false, failOn: 'user', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--source': args.source = value(); break;
      case '--all': args.all = true; break;
      case '--json': args.json = true; break;
      case '--fail-on': args.failOn = value().toLowerCase(); break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['user', 'review', 'none'].includes(args.failOn)) throw new Error('--fail-on must be user, review, or none');
  return args;
}

function memberParts(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) return [...memberParts(node.expression), node.name.text];
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return [...memberParts(node.expression), node.argumentExpression.text];
  }
  return [];
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return '';
}

function findObjectProperty(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer;
  }
  return null;
}

function isTranslationCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return ['t', 'translateBot'].includes(node.expression.text);
  const parts = memberParts(node.expression);
  return ['t', 'translateBot'].includes(parts.at(-1));
}

function telegramSinkExpressions(call) {
  const parts = memberParts(call.expression);
  const root = parts[0] || '';
  const method = parts.at(-1) || '';
  const result = [];
  const directMethods = new Set(['reply', 'replyWithHTML', 'replyWithMarkdown', 'replyWithMarkdownV2', 'editMessageText', 'answerCbQuery']);
  const mediaMethods = new Set(['replyWithPhoto', 'replyWithVideo', 'replyWithAnimation', 'replyWithAudio', 'replyWithVoice', 'replyWithDocument']);

  if (root === 'ctx' && directMethods.has(method) && call.arguments[0]) result.push(call.arguments[0]);
  if ((root === 'ctx' || root === 'bot') && parts.includes('telegram') && method === 'sendMessage' && call.arguments[1]) result.push(call.arguments[1]);
  if (root === 'ctx' && parts.includes('telegram') && ['editMessageText', 'editMessageCaption'].includes(method) && call.arguments[3]) result.push(call.arguments[3]);
  if (root === 'ctx' && mediaMethods.has(method) && call.arguments[1]) result.push(call.arguments[1]);
  if ((root === 'ctx' || root === 'bot') && parts.includes('telegram') && ['sendPhoto', 'sendVideo', 'sendAnimation', 'sendAudio', 'sendVoice', 'sendDocument'].includes(method) && call.arguments[2]) result.push(call.arguments[2]);
  if (parts.length >= 3 && parts.at(-3) === 'Markup' && parts.at(-2) === 'button' && call.arguments[0]) result.push(call.arguments[0]);
  if (ts.isIdentifier(call.expression) && call.expression.text === 'safeReply' && call.arguments[1]) result.push(call.arguments[1]);
  if (ts.isIdentifier(call.expression) && call.expression.text === 'safeSendToUser' && call.arguments[1]) result.push(call.arguments[1]);
  return result;
}

function lexicalScope(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return sourceFile;
}

function scopeDepth(scope) {
  let depth = 0;
  for (let current = scope.parent; current; current = current.parent) if (ts.isFunctionLike(current)) depth += 1;
  return depth;
}

function countCyrillicCommentLines(text) {
  let inBlock = false;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    let comment = '';
    const blockStart = line.indexOf('/*');
    const blockEnd = line.indexOf('*/');
    const lineStart = line.indexOf('//');
    if (inBlock) comment = line;
    else if (blockStart >= 0 && (lineStart < 0 || blockStart < lineStart)) comment = line.slice(blockStart);
    else if (lineStart >= 0) comment = line.slice(lineStart);
    if (CYRILLIC.test(comment)) count += 1;
    if (!inBlock && blockStart >= 0 && blockEnd < blockStart) inBlock = true;
    if (inBlock && blockEnd >= 0) inBlock = false;
  }
  return count;
}

function preview(text, max = 150) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const sourcePath = path.resolve(projectRoot, args.source);
  const sourceText = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records = [];
  const recordByNode = new Map();
  const declarations = new Map();
  const assignments = new Map();
  const sinks = [];

  const addDefinition = (map, name, entry) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(entry);
  };

  const addRecord = (node, text, literalKind) => {
    if (!CYRILLIC.test(text)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const record = { node, text, literalKind, line: position.line + 1, column: position.character + 1 };
    records.push(record);
    recordByNode.set(node, record);
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      addDefinition(declarations, node.name.text, { expression: node.initializer, start: node.getStart(sourceFile), scope: lexicalScope(node, sourceFile) });
    }
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && [
      ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(node.operatorToken.kind)) {
      addDefinition(assignments, node.left.text, { expression: node.right, start: node.getStart(sourceFile), scope: lexicalScope(node, sourceFile) });
    }
    if (ts.isCallExpression(node)) sinks.push(...telegramSinkExpressions(node));

    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) text += '{{…}}' + span.literal.text;
      addRecord(node, text, 'template');
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) addRecord(node, node.text, 'string');
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const outputRecords = new Map();
  const visitedExpressions = new Set();
  const resolveDefinitions = (identifier) => {
    const name = identifier.text;
    const usageStart = identifier.getStart(sourceFile);
    const compatible = (declarations.get(name) || []).filter((entry) => entry.start <= usageStart && entry.scope.pos <= identifier.pos && entry.scope.end >= identifier.end);
    compatible.sort((a, b) => scopeDepth(b.scope) - scopeDepth(a.scope) || b.start - a.start);
    const declaration = compatible[0];
    if (!declaration) return [];
    const updates = (assignments.get(name) || []).filter((entry) => entry.scope === declaration.scope && entry.start >= declaration.start && entry.start <= usageStart);
    return [declaration, ...updates];
  };

  const trace = (node, indirect = false) => {
    const token = `${node.pos}:${node.end}:${indirect ? 'indirect' : 'direct'}`;
    if (visitedExpressions.has(token) || isTranslationCall(node)) return;
    visitedExpressions.add(token);
    const directRecord = recordByNode.get(node);
    if (directRecord) {
      const current = outputRecords.get(directRecord);
      if (!current || current === 'indirect' && !indirect) outputRecords.set(directRecord, indirect ? 'indirect' : 'direct');
    }
    if (ts.isIdentifier(node)) {
      for (const definition of resolveDefinitions(node)) trace(definition.expression, true);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) trace(span.expression, indirect);
      return;
    }
    ts.forEachChild(node, (child) => trace(child, indirect));
  };
  for (const sink of sinks) trace(sink);

  const ancestorCallParts = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isCallExpression(current)) return memberParts(current.expression);
    }
    return [];
  };
  const enclosingVariableName = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    }
    return '';
  };
  const isInsideError = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'Error') return true;
    }
    return false;
  };

  const findings = records.map((record) => {
    const outputFlow = outputRecords.get(record);
    if (outputFlow === 'direct') return { ...record, category: 'USER', reason: 'appears directly in a Telegram output expression' };
    if (outputFlow === 'indirect') return { ...record, category: 'REVIEW', reason: 'may flow to Telegram output through a variable' };
    const callParts = ancestorCallParts(record.node);
    if (callParts[0] === 'console') return { ...record, category: 'INTERNAL', reason: 'console output' };
    if (isInsideError(record.node)) return { ...record, category: 'REVIEW', reason: 'error text may surface through a catch block' };
    if (callParts.some((part) => ['prepare', 'exec'].includes(part))) return { ...record, category: 'REVIEW', reason: 'database text may become user-visible data' };
    const variableName = enclosingVariableName(record.node);
    if (/PROMPT|SYSTEM|INSTRUCTION/i.test(variableName)) return { ...record, category: 'REVIEW', reason: 'AI prompt or instruction' };
    return { ...record, category: 'REVIEW', reason: 'unclassified runtime Cyrillic' };
  });

  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.category}\u0000${finding.reason}\u0000${finding.text}`;
    if (!grouped.has(key)) grouped.set(key, { category: finding.category, reason: finding.reason, text: finding.text, lines: [] });
    grouped.get(key).lines.push(finding.line);
  }
  const groups = [...grouped.values()].sort((a, b) => {
    const order = { USER: 0, REVIEW: 1, INTERNAL: 2 };
    return order[a.category] - order[b.category] || a.lines[0] - b.lines[0];
  });
  const counts = {
    user: groups.filter((item) => item.category === 'USER').length,
    review: groups.filter((item) => item.category === 'REVIEW').length,
    internal: groups.filter((item) => item.category === 'INTERNAL').length,
    literalOccurrences: records.length,
    cyrillicCommentLines: countCyrillicCommentLines(sourceText),
  };

  if (args.json) {
    console.log(JSON.stringify({ source: sourcePath, counts, findings: groups }, null, 2));
  } else {
    console.log(`Source: ${path.relative(projectRoot, sourcePath)}`);
    console.log(`Cyrillic literals: ${counts.literalOccurrences}; USER: ${counts.user}; REVIEW: ${counts.review}; INTERNAL: ${counts.internal}; comment lines: ${counts.cyrillicCommentLines}`);
    for (const group of groups) {
      if (group.category === 'INTERNAL' && !args.all) continue;
      const lines = [...new Set(group.lines)].slice(0, 8).join(', ');
      const more = new Set(group.lines).size > 8 ? ', …' : '';
      console.log(`[${group.category}] lines ${lines}${more} — ${group.reason}`);
      console.log(`  ${preview(group.text)}`);
    }
    if (!args.all && counts.internal) console.log(`Internal console groups hidden: ${counts.internal}. Use --all to show them.`);
  }

  if (args.failOn === 'user' && counts.user > 0) process.exitCode = 1;
  if (args.failOn === 'review' && (counts.user > 0 || counts.review > 0)) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`i18n audit failed: ${error.message}`);
  process.exitCode = 1;
}
