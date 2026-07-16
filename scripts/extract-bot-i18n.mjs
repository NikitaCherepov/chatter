#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const DIRECT_TEXT_METHODS = new Set([
  'reply', 'replyWithHTML', 'replyWithMarkdown', 'replyWithMarkdownV2',
  'editMessageText', 'answerCbQuery',
]);
const CAPTION_METHODS = new Set([
  'replyWithPhoto', 'replyWithVideo', 'replyWithAnimation', 'replyWithAudio',
  'replyWithVoice', 'replyWithDocument',
]);
const BUTTON_METHODS = new Set([
  'callback', 'url', 'webApp', 'login', 'switchToChat',
  'switchToCurrentChat', 'locationRequest', 'contactRequest', 'pollRequest',
]);

function printHelp() {
  console.log(`Usage:
  npm run i18n:extract:bot
  npm run i18n:extract:bot -- --interactive
  npm run i18n:extract:bot -- --write

Options:
  --source <file>       TypeScript source (default: index.ts)
  --catalog <file>      Source-language catalog (default: i18n/locales/ru/translation.json)
  --namespace <name>    Namespace for generated keys (default: generated)
  --ai-keys             Ask the configured OpenAI-compatible model for semantic key names
  --env <file>          API env file for --ai-keys (default: .env.i18n)
  --ai-batch-size <n>   Candidates per key-naming request (default: 25)
  --dry-run             Report only (this is the default)
  --interactive         Ask before each safe replacement, then write accepted changes
  --write               Apply every safe replacement without prompts
  --show-existing       Also print strings already present in the catalog
  --help                Show this help

The script scans Telegraf replies, edited messages, callback answers, inline
button labels, Telegram sendMessage calls, and media captions. Template values
become i18next placeholders. Ambiguous target language or nested translatable
expressions are reported as manual and never changed automatically.

--ai-keys sends only static UI text, handler context, call kind, and placeholder
names. It does not send runtime values. Dry-run with --ai-keys still calls the API.`);
}

function parseArgs(argv) {
  const args = {
    source: 'index.ts',
    catalog: 'i18n/locales/ru/translation.json',
    namespace: 'generated',
    aiKeys: false,
    env: '.env.i18n',
    aiBatchSize: 25,
    mode: 'dry-run',
    showExisting: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--source': args.source = value(); break;
      case '--catalog': args.catalog = value(); break;
      case '--namespace': args.namespace = value(); break;
      case '--ai-keys': args.aiKeys = true; break;
      case '--env': args.env = value(); break;
      case '--ai-batch-size': {
        args.aiBatchSize = Number.parseInt(value(), 10);
        if (!Number.isSafeInteger(args.aiBatchSize) || args.aiBatchSize <= 0) throw new Error('--ai-batch-size must be a positive integer');
        break;
      }
      case '--dry-run': args.mode = 'dry-run'; break;
      case '--interactive': args.mode = 'interactive'; break;
      case '--write': args.mode = 'write'; break;
      case '--show-existing': args.showExisting = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(args.namespace)) {
    throw new Error('--namespace must be a simple JSON property name');
  }
  return args;
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function normalizeChatCompletionsUrl(raw) {
  const url = raw.trim().replace(/\/+$/, '');
  if (!url) throw new Error('I18N_TRANSLATE_API_URL is empty');
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
}

function parseExtraHeaders(raw) {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('I18N_TRANSLATE_EXTRA_HEADERS must be a JSON object');
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

function resolveAiProvider(apiUrl) {
  const configured = (process.env.I18N_TRANSLATE_PROVIDER || 'auto').trim().toLowerCase();
  if (configured !== 'auto') return configured;
  if (apiUrl.toLowerCase().includes('openrouter.ai')) return 'openrouter';
  if (apiUrl.toLowerCase().includes('deepseek.com')) return 'deepseek';
  return 'generic';
}

function adaptAiBody(body, provider) {
  const level = (process.env.I18N_TRANSLATE_REASONING_LEVEL || 'none').trim().toLowerCase();
  if (provider === 'openrouter') {
    if (level !== 'auto') body.reasoning = { effort: level };
  } else if (provider === 'deepseek') {
    if (level === 'none' || level === 'minimal') body.thinking = { type: 'disabled' };
    else if (level !== 'auto') body.reasoning_effort = level === 'xhigh' ? 'max' : level;
  }
  return body;
}

function createAiConfig(envFile) {
  loadEnvFile(envFile);
  const apiKey = (process.env.I18N_TRANSLATE_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const allowNoKey = /^(1|true|yes)$/i.test(process.env.I18N_TRANSLATE_ALLOW_NO_KEY || '');
  if (!apiKey && !allowNoKey) throw new Error(`No API key for --ai-keys. Configure I18N_TRANSLATE_API_KEY in ${envFile}`);
  const apiUrl = normalizeChatCompletionsUrl(process.env.I18N_TRANSLATE_API_URL || 'https://api.openai.com/v1');
  return {
    apiKey,
    apiUrl,
    model: (process.env.I18N_TRANSLATE_MODEL || 'gpt-4o-mini').trim(),
    provider: resolveAiProvider(apiUrl),
    extraHeaders: parseExtraHeaders(process.env.I18N_TRANSLATE_EXTRA_HEADERS || ''),
    jsonMode: !/^(0|false|no)$/i.test(process.env.I18N_TRANSLATE_JSON_MODE || 'true'),
    timeoutMs: Number.parseInt(process.env.I18N_TRANSLATE_TIMEOUT_MS || '120000', 10),
    maxRetries: Number.parseInt(process.env.I18N_TRANSLATE_MAX_RETRIES || '3', 10),
  };
}

function extractAiResponseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  throw new Error('AI response has no choices[0].message.content');
}

function parseAiJson(text) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestAiKeyBatch(batch, config) {
  const payload = Object.fromEntries(batch.map((candidate, index) => [`c${index + 1}`, {
    text: candidate.message.text,
    context: scopeName(candidate.node, candidate.sourceFile),
    kind: candidate.kind,
    placeholders: candidate.message.placeholders.map((item) => item.name),
  }]));
  let body = {
    model: config.model,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: [
          'Create semantic i18next key identifiers for Telegram bot UI strings.',
          'Return only JSON shaped exactly as {"keys":{"c1":"semanticName"}}.',
          'Return every input id exactly once.',
          'Values must be unique English lowerCamelCase identifiers using only ASCII letters and digits.',
          'Use concise product-domain meaning such as voiceTooLarge, pcCommandConfirmation, rejectWithComment.',
          'Do not transliterate or copy the sentence. Do not include the namespace. Do not use dots.',
          'Use context and kind only to disambiguate meaning.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ],
  };
  if (config.jsonMode) body.response_format = { type: 'json_object' };
  body = adaptAiBody(body, config.provider);

  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      const headers = { 'Content-Type': 'application/json', ...config.extraHeaders };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
      const parsed = parseAiJson(extractAiResponseText(await response.json()));
      if (!parsed?.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) throw new Error('AI JSON has no keys object');
      const expected = Object.keys(payload).sort();
      const returned = Object.keys(parsed.keys).sort();
      if (JSON.stringify(expected) !== JSON.stringify(returned)) throw new Error(`AI returned unexpected ids: ${returned.join(', ')}`);
      for (const id of expected) {
        if (!/^[a-z][A-Za-z0-9]{2,79}$/.test(parsed.keys[id])) throw new Error(`${id}: invalid key identifier ${JSON.stringify(parsed.keys[id])}`);
      }
      return batch.map((candidate, index) => [candidate, parsed.keys[`c${index + 1}`]]);
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxRetries) break;
      await sleep(Math.min(10_000, 750 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function generateAiKeyNames(candidates, args, envFile) {
  if (!candidates.length) return new Map();
  const config = createAiConfig(envFile);
  console.log(`AI key naming: provider=${config.provider}, model=${config.model}, candidates=${candidates.length}`);
  const result = new Map();
  const batches = chunk(candidates, args.aiBatchSize);
  let completed = 0;
  for (const batch of batches) {
    console.log(`Naming keys ${completed + 1}-${completed + batch.length}/${candidates.length}...`);
    for (const [candidate, name] of await requestAiKeyBatch(batch, config)) result.set(candidate.message.text, name);
    completed += batch.length;
  }
  return result;
}

function readCatalog(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Catalog root must be an object: ${file}`);
  }
  return { raw, value };
}

function flattenStrings(value, prefix = '', result = new Map()) {
  for (const [name, child] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof child === 'string') result.set(key, child);
    else if (child && typeof child === 'object' && !Array.isArray(child)) flattenStrings(child, key, result);
  }
  return result;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return '';
}

function memberParts(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) return [...memberParts(node.expression), node.name.text];
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return [...memberParts(node.expression), node.argumentExpression.text];
  }
  return [];
}

function findObjectProperty(objectNode, name) {
  if (!objectNode || !ts.isObjectLiteralExpression(objectNode)) return null;
  for (const property of objectNode.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer;
  }
  return null;
}

function callTextTargets(call) {
  const parts = memberParts(call.expression);
  const method = parts.at(-1) || '';
  const root = parts[0] || '';
  const targets = [];

  if (root === 'ctx' && DIRECT_TEXT_METHODS.has(method) && call.arguments[0]) {
    targets.push({ node: call.arguments[0], kind: method, translator: 'ctx.t', confidence: 'safe' });
  }

  if (root === 'ctx' && parts.includes('telegram') && method === 'editMessageText' && call.arguments[3]) {
    targets.push({ node: call.arguments[3], kind: 'telegramEdit', translator: 'ctx.t', confidence: 'safe' });
  }

  if (root === 'ctx' && parts.includes('telegram') && method === 'sendMessage' && call.arguments[1]) {
    targets.push({ node: call.arguments[1], kind: 'telegramSend', translator: 'ctx.t', confidence: 'safe' });
  }

  if (root === 'bot' && parts.includes('telegram') && method === 'sendMessage' && call.arguments[1]) {
    targets.push({ node: call.arguments[1], kind: 'botSend', translator: null, confidence: 'manual', reason: 'target user language must be chosen explicitly' });
  }

  if (root === 'ctx' && CAPTION_METHODS.has(method)) {
    const caption = findObjectProperty(call.arguments[1], 'caption');
    if (caption) targets.push({ node: caption, kind: 'caption', translator: 'ctx.t', confidence: 'safe' });
  }

  if ((root === 'ctx' || root === 'bot') && parts.includes('telegram') && ['sendPhoto', 'sendVideo', 'sendAnimation', 'sendAudio', 'sendVoice', 'sendDocument'].includes(method)) {
    const caption = findObjectProperty(call.arguments[2], 'caption');
    if (caption) {
      targets.push({
        node: caption,
        kind: 'caption',
        translator: root === 'ctx' ? 'ctx.t' : null,
        confidence: root === 'ctx' ? 'safe' : 'manual',
        reason: root === 'bot' ? 'target user language must be chosen explicitly' : undefined,
      });
    }
  }

  if (parts.length >= 3 && parts.at(-3) === 'Markup' && parts.at(-2) === 'button' && BUTTON_METHODS.has(method) && call.arguments[0]) {
    targets.push({ node: call.arguments[0], kind: `button.${method}`, translator: null, confidence: 'infer' });
  }

  if (ts.isIdentifier(call.expression) && call.expression.text === 'safeReply' && call.arguments[1]) {
    targets.push({ node: call.arguments[1], kind: 'safeReply', translator: 'ctx.t', confidence: 'safe' });
  }

  if (ts.isIdentifier(call.expression) && call.expression.text === 'safeSendToUser' && call.arguments[1]) {
    targets.push({ node: call.arguments[1], kind: 'safeSendToUser', translator: null, confidence: 'manual', reason: 'target user language must be chosen explicitly' });
  }

  return targets;
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function inferTranslator(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const params = new Set(current.parameters.flatMap((param) => ts.isIdentifier(param.name) ? [param.name.text] : []));
    if (params.has('t')) return 't';
    if (params.has('ctx')) return 'ctx.t';
  }
  return null;
}

function isTranslationExpression(node) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === 't' || node.expression.text === 'translateBot';
  const parts = memberParts(node.expression);
  return parts.at(-1) === 't' || parts.at(-1) === 'translateBot';
}

function containsNaturalLanguage(text) {
  const visibleText = text.replace(/\{\{[^}]+\}\}/g, ' ');
  return /\p{L}/u.test(visibleText) && !/^https?:\/\/\S+$/u.test(visibleText.trim());
}

function containsNestedText(node) {
  let found = false;
  const visit = (child) => {
    if (child !== node && isTranslationExpression(child)) return;
    if (child !== node && (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child)) && containsNaturalLanguage(child.text)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function placeholderBase(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) return expression.expression.name.text;
  return 'value';
}

function safePlaceholderName(raw) {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z_]+/, '');
  return cleaned || 'value';
}

function extractMessage(node, sourceFile) {
  const placeholders = [];
  const names = new Set();
  let hasLiteral = false;

  const addExpression = (expression) => {
    if (containsNestedText(expression)) throw new Error('nested translatable expression');
    let base = safePlaceholderName(placeholderBase(expression));
    let name = base;
    let index = 2;
    while (names.has(name)) name = `${base}${index++}`;
    names.add(name);
    placeholders.push({ name, expression: expression.getText(sourceFile) });
    return `{{${name}}}`;
  };

  const read = (current) => {
    if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      hasLiteral = true;
      return current.text;
    }
    if (ts.isTemplateExpression(current)) {
      hasLiteral = true;
      let text = current.head.text;
      for (const span of current.templateSpans) text += addExpression(span.expression) + span.literal.text;
      return text;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return read(current.left) + read(current.right);
    }
    return addExpression(current);
  };

  try {
    const text = read(node);
    if (!hasLiteral || !containsNaturalLanguage(text)) return { ok: false, reason: 'no natural-language literal' };
    return { ok: true, text, placeholders };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(value) {
  return [...value.toLowerCase()].map((char) => CYRILLIC_MAP[char] ?? char).join('');
}

function camelId(value, fallback = 'message') {
  const words = transliterate(value)
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  if (!words.length) return fallback;
  return words[0] + words.slice(1).map((word) => word[0].toUpperCase() + word.slice(1)).join('');
}

function scopeName(node, sourceFile) {
  let fallback = '';
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    if (ts.isCallExpression(current.parent)) {
      const parts = memberParts(current.parent.expression);
      const handler = parts.at(-1) || 'handler';
      const first = current.parent.arguments[0];
      if (parts[0] === 'bot' && ['action', 'command', 'on', 'start', 'help'].includes(handler)) {
        return first && ts.isStringLiteralLike(first) ? `${handler}_${first.text}` : handler;
      }
      fallback ||= handler;
    }
  }
  if (fallback) return fallback;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `handler${line}`;
}

function identifierId(value) {
  const parts = value.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'handler';
  const first = parts[0][0].toLowerCase() + parts[0].slice(1);
  return first + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function uniqueGeneratedId(candidate, namespaceObject, pending, preferredBase = '') {
  const scope = identifierId(scopeName(candidate.node, candidate.sourceFile));
  const message = camelId(candidate.message.text, candidate.kind.replace(/[^A-Za-z0-9]/g, ''));
  const deterministicBase = `${scope}${message[0]?.toUpperCase() || ''}${message.slice(1)}`.slice(0, 90) || `message${candidate.line}`;
  const base = preferredBase || deterministicBase;
  let id = base;
  let suffix = 2;
  while ((Object.hasOwn(namespaceObject, id) && namespaceObject[id] !== candidate.message.text) || (pending.has(id) && pending.get(id) !== candidate.message.text)) {
    id = `${base}${suffix++}`;
  }
  return id;
}

function quoteCode(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function replacementFor(candidate, key) {
  const args = candidate.message.placeholders.length
    ? `, { ${candidate.message.placeholders.map(({ name, expression }) => `${name}: ${expression}`).join(', ')} }`
    : '';
  return `${candidate.translator}(${quoteCode(key)}${args})`;
}

function markdownKinds(text) {
  const kinds = [];
  if (/```|`[^`]+`/.test(text)) kinds.push('code');
  if (/\*\*|__|~~|(^|\s)[*_][^\n]+[*_]/m.test(text)) kinds.push('emphasis');
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) kinds.push('link');
  if (/(^|\n)\s*[-*+]\s+/.test(text)) kinds.push('list');
  if (/(^|\n)\s*>\s+/.test(text)) kinds.push('quote');
  return kinds;
}

function appendCatalogEntries(raw, namespace, entries) {
  if (!entries.size) return raw;
  const jsonFile = ts.parseJsonText('catalog.json', raw);
  const root = jsonFile.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) throw new Error('Cannot locate catalog root object');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const rendered = [...entries.entries()].map(([id, value]) => `    ${JSON.stringify(id)}: ${JSON.stringify(value)}`).join(`,${eol}`);
  const namespaceProperty = root.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === namespace);

  if (!namespaceProperty) {
    if (root.properties.length) {
      const position = root.properties.at(-1).getEnd();
      return `${raw.slice(0, position)},${eol}  ${JSON.stringify(namespace)}: {${eol}${rendered}${eol}  }${raw.slice(position)}`;
    }
    const position = root.getStart(jsonFile) + 1;
    return `${raw.slice(0, position)}${eol}  ${JSON.stringify(namespace)}: {${eol}${rendered}${eol}  }${raw.slice(position)}`;
  }
  if (!ts.isPropertyAssignment(namespaceProperty) || !ts.isObjectLiteralExpression(namespaceProperty.initializer)) {
    throw new Error(`Catalog property ${namespace} must be an object`);
  }
  const object = namespaceProperty.initializer;
  if (object.properties.length) {
    const position = object.properties.at(-1).getEnd();
    return `${raw.slice(0, position)},${eol}${rendered}${raw.slice(position)}`;
  }
  const position = object.getStart(jsonFile) + 1;
  return `${raw.slice(0, position)}${eol}${rendered}${raw.slice(position)}`;
}

function preview(text, max = 110) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

async function chooseInteractive(candidates) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const accepted = [];
  let acceptAll = false;
  try {
    for (const candidate of candidates) {
      if (acceptAll) {
        accepted.push(candidate);
        continue;
      }
      console.log(`\n${candidate.sourceFile.fileName}:${candidate.line} [${candidate.kind}]`);
      console.log(`  ${preview(candidate.message.text, 180)}`);
      console.log(`  -> ${candidate.key}`);
      const answer = (await rl.question('Apply? [y]es / [n]o / [a]ll / [q]uit: ')).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 'a') {
        acceptAll = true;
        accepted.push(candidate);
      } else if (answer === 'y' || answer === 'yes') {
        accepted.push(candidate);
      }
    }
  } finally {
    rl.close();
  }
  return accepted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const sourcePath = path.resolve(projectRoot, args.source);
  const catalogPath = path.resolve(projectRoot, args.catalog);
  const sourceText = fs.readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '');
  const { raw: catalogRaw, value: catalog } = readCatalog(catalogPath);
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const catalogStrings = flattenStrings(catalog);
  const existingByValue = new Map();
  for (const [key, value] of catalogStrings) if (!existingByValue.has(value)) existingByValue.set(value, key);
  const namespaceObject = catalog[args.namespace] && typeof catalog[args.namespace] === 'object' && !Array.isArray(catalog[args.namespace])
    ? catalog[args.namespace]
    : {};

  const candidates = [];
  const manual = [];
  const seenRanges = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      for (const target of callTextTargets(node)) {
        const range = `${target.node.getStart(sourceFile)}:${target.node.getEnd()}`;
        if (seenRanges.has(range)) continue;
        seenRanges.add(range);
        if (isTranslationExpression(target.node)) continue;
        const message = extractMessage(target.node, sourceFile);
        if (!message.ok) {
          if (message.reason !== 'no natural-language literal') manual.push({ ...target, node: target.node, message, sourceFile });
          continue;
        }
        let translator = target.translator;
        let confidence = target.confidence;
        let reason = target.reason;
        if (confidence === 'infer') {
          translator = inferTranslator(target.node);
          confidence = translator ? 'safe' : 'manual';
          if (!translator) reason = 'cannot infer t or ctx.t in this helper';
        }
        const position = sourceFile.getLineAndCharacterOfPosition(target.node.getStart(sourceFile));
        const item = { ...target, translator, confidence, reason, node: target.node, message, sourceFile, line: position.line + 1, column: position.character + 1 };
        if (confidence === 'safe') candidates.push(item);
        else manual.push(item);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const uniqueNewCandidates = [];
  const newValues = new Set();
  for (const candidate of candidates) {
    if (existingByValue.has(candidate.message.text) || newValues.has(candidate.message.text)) continue;
    newValues.add(candidate.message.text);
    uniqueNewCandidates.push(candidate);
  }
  const aiNames = args.aiKeys
    ? await generateAiKeyNames(uniqueNewCandidates, args, path.resolve(projectRoot, args.env))
    : new Map();

  const pendingValues = new Map();
  const pendingIds = new Map();
  for (const candidate of candidates) {
    const existing = existingByValue.get(candidate.message.text) || pendingValues.get(candidate.message.text);
    if (existing) {
      candidate.key = existing;
      candidate.existing = true;
    } else {
      const id = uniqueGeneratedId(candidate, namespaceObject, pendingIds, aiNames.get(candidate.message.text) || '');
      candidate.key = `${args.namespace}.${id}`;
      candidate.generatedId = id;
      pendingValues.set(candidate.message.text, candidate.key);
      pendingIds.set(id, candidate.message.text);
    }
  }

  console.log(`Source: ${path.relative(projectRoot, sourcePath)}`);
  console.log(`Catalog: ${path.relative(projectRoot, catalogPath)} (${catalogStrings.size} strings)`);
  console.log(`Safe candidates: ${candidates.length}; manual review: ${manual.length}`);

  for (const candidate of candidates) {
    if (candidate.existing && !args.showExisting) continue;
    const markdown = markdownKinds(candidate.message.text);
    console.log(`[safe] ${candidate.line}:${candidate.column} ${candidate.kind}${markdown.length ? ` markdown:${markdown.join(',')}` : ''}`);
    console.log(`  ${preview(candidate.message.text)}`);
    console.log(`  -> ${candidate.key}${candidate.existing ? ' (reuse)' : ''}`);
  }
  for (const item of manual) {
    const line = sourceFile.getLineAndCharacterOfPosition(item.node.getStart(sourceFile)).line + 1;
    console.log(`[manual] ${line} ${item.kind}: ${item.reason || item.message.reason}`);
    if (item.message.ok) console.log(`  ${preview(item.message.text)}`);
  }

  if (args.mode === 'dry-run') {
    console.log('\nDry run only. Use --interactive to approve replacements or --write to apply every safe candidate.');
    return;
  }

  const selected = args.mode === 'interactive' ? await chooseInteractive(candidates) : candidates;
  if (!selected.length) {
    if (!candidates.length && manual.length) {
      console.log(`No safe candidates. ${manual.length} manual item(s) require a code-aware edit and are not changed by --interactive.`);
    } else if (!candidates.length) {
      console.log('Nothing to do: no safe or manual localization candidates remain.');
    } else {
      console.log('No safe changes selected.');
    }
    return;
  }

  const edits = selected
    .map((candidate) => ({ start: candidate.node.getStart(sourceFile), end: candidate.node.getEnd(), text: replacementFor(candidate, candidate.key) }))
    .sort((a, b) => b.start - a.start);
  let nextSource = sourceText;
  for (const edit of edits) nextSource = `${nextSource.slice(0, edit.start)}${edit.text}${nextSource.slice(edit.end)}`;

  const additions = new Map();
  for (const candidate of selected) {
    if (candidate.generatedId && !Object.hasOwn(namespaceObject, candidate.generatedId)) additions.set(candidate.generatedId, candidate.message.text);
  }
  const nextCatalog = appendCatalogEntries(catalogRaw, args.namespace, additions);
  fs.writeFileSync(sourcePath, nextSource, 'utf8');
  if (additions.size) fs.writeFileSync(catalogPath, nextCatalog, 'utf8');
  console.log(`Applied ${selected.length} replacements; added ${additions.size} catalog strings.`);
}

main().catch((error) => {
  console.error(`i18n extraction failed: ${error.message}`);
  process.exitCode = 1;
});
