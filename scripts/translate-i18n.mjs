#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

function printHelp() {
  console.log(`Usage:
  npm run i18n:translate:bot -- --from en --to ru
  npm run i18n:translate:desktop -- --from en --to de
  npm run i18n:translate:bot:all

Options:
  --all                  Fill every existing locale catalog
  --from <locale>        Source locale (default: ru; en with --all)
  --to <locale>          Target locale (default: en)
  --locales <directory>  Locale catalogs root (default: i18n/locales)
  --changelog <file>     Translate changes arrays inside one changelog JSON
  --source <file>        Source JSON path
  --target <file>        Target JSON path
  --env <file>           Env file path (default: .env.i18n)
  --batch-size <number>  Strings per API request (default: env or 1)
  --provider <name>      auto, openrouter, deepseek, or generic
  --reasoning <level>    auto, none, minimal, low, medium, high, or xhigh
  --limit <number>       Translate at most N missing strings per target
  --force                Translate every source string, including existing ones
  --dry-run              Print missing keys without creating files or calling API
  --help                 Show this help

The target file is created when absent. Existing translations and extra target
keys are preserved unless --force is used. Empty target strings count as missing.
In --all mode, locale directories are scanned automatically and processed one by one.`);
}

function parseArgs(argv) {
  const args = {
    all: false,
    from: '',
    to: '',
    locales: '',
    changelog: '',
    source: '',
    target: '',
    env: '',
    batchSize: 0,
    provider: '',
    reasoning: '',
    limit: 0,
    force: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--all': args.all = true; break;
      case '--from': args.from = takeValue(); break;
      case '--to': args.to = takeValue(); break;
      case '--locales': args.locales = takeValue(); break;
      case '--changelog': args.changelog = takeValue(); break;
      case '--source': args.source = takeValue(); break;
      case '--target': args.target = takeValue(); break;
      case '--env': args.env = takeValue(); break;
      case '--batch-size': args.batchSize = parsePositiveInt(takeValue(), '--batch-size'); break;
      case '--provider': args.provider = takeValue(); break;
      case '--reasoning': args.reasoning = takeValue(); break;
      case '--limit': args.limit = parsePositiveInt(takeValue(), '--limit'); break;
      case '--force': args.force = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(value, fallback, name) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readJson(file, label) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cannot read ${label} catalog ${file}: ${error.message}`);
  }
}

function flattenStrings(value, currentPath = [], result = []) {
  if (typeof value === 'string') {
    result.push({ path: currentPath, key: currentPath.join('.'), source: value });
    return result;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Unsupported non-string value at ${currentPath.join('.') || '<root>'}`);
  }

  for (const [key, child] of Object.entries(value)) {
    flattenStrings(child, [...currentPath, key], result);
  }
  return result;
}

function getPath(object, parts) {
  let current = object;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function setPath(object, parts, value) {
  let current = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeChatCompletionsUrl(rawUrl) {
  const url = rawUrl.trim().replace(/\/+$/, '');
  if (!url) throw new Error('I18N_TRANSLATE_API_URL is empty');
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
}

const PROVIDERS = new Set(['auto', 'openrouter', 'deepseek', 'generic']);
const REASONING_LEVELS = new Set(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function resolveProvider(apiUrl, rawProvider) {
  const requested = (rawProvider || 'auto').trim().toLowerCase();
  if (!PROVIDERS.has(requested)) {
    throw new Error('I18N_TRANSLATE_PROVIDER must be auto, openrouter, deepseek, or generic');
  }
  if (requested !== 'auto') return requested;

  const url = apiUrl.toLowerCase();
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('deepseek.com')) return 'deepseek';
  return 'generic';
}

function parseReasoningLevel(rawLevel) {
  const level = (rawLevel || 'none').trim().toLowerCase();
  if (!REASONING_LEVELS.has(level)) {
    throw new Error('I18N_TRANSLATE_REASONING_LEVEL must be auto, none, minimal, low, medium, high, or xhigh');
  }
  return level;
}

// Kept in sync with backend-api/src/services/ai.ts provider adaptation:
// OpenRouter and direct DeepSeek expose different reasoning controls.
function adaptRequestBodyForProvider(requestBody, provider, level) {
  if (provider === 'openrouter') {
    const { thinking: _thinking, clear_thinking: _clearThinking, reasoning_effort: _reasoningEffort, ...body } = requestBody;
    if (level !== 'auto') body.reasoning = { effort: level };
    return body;
  }

  if (provider === 'deepseek') {
    const { thinking: _thinking, clear_thinking: _clearThinking, reasoning_effort: _reasoningEffort, reasoning: _reasoning, ...body } = requestBody;
    if (level === 'auto') return body;
    if (level === 'none' || level === 'minimal') {
      body.thinking = { type: 'disabled' };
    } else if (level === 'low' || level === 'medium') {
      body.reasoning_effort = 'high';
    } else if (level === 'xhigh') {
      body.reasoning_effort = 'max';
    } else {
      body.reasoning_effort = level;
    }
    return body;
  }

  if (level !== 'auto' && level !== 'none') {
    throw new Error(`Reasoning level ${level} needs a recognized provider; set I18N_TRANSLATE_PROVIDER explicitly`);
  }
  return requestBody;
}

function parseExtraHeaders(raw) {
  if (!raw?.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`I18N_TRANSLATE_EXTRA_HEADERS must be valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('I18N_TRANSLATE_EXTRA_HEADERS must be a JSON object');
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

function extractResponseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  }
  throw new Error('API response has no choices[0].message.content');
}

function parseModelJson(text) {
  const cleaned = text.trim()
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Model returned invalid JSON: ${error.message}`);
  }
}

function collectProtectedTokens(text) {
  const patterns = [
    /\{\{\s*[^{}]+?\s*\}\}/g,
    /\$\{[^{}]+?\}/g,
    /%\d*\$?[sdif]/g,
    /https?:\/\/[^\s<>()]+/g,
  ];
  return patterns.flatMap((pattern) => text.match(pattern) || []).sort();
}

function isUrlOnly(text) {
  return /^https?:\/\/\S+$/u.test(text.trim());
}

function validateTranslation(entry, translation) {
  if (typeof translation !== 'string') throw new Error(`${entry.key}: translation is not a string`);
  if (entry.source.trim() && !translation.trim()) throw new Error(`${entry.key}: translation is empty`);

  const sourceTokens = collectProtectedTokens(entry.source);
  const targetTokens = collectProtectedTokens(translation);
  if (JSON.stringify(sourceTokens) !== JSON.stringify(targetTokens)) {
    throw new Error(`${entry.key}: protected placeholders or URLs changed`);
  }
}

function makePrompt(entries, sourceLanguage, targetLanguage) {
  const payload = Object.fromEntries(entries.map((entry) => [entry.key, entry.source]));
  return JSON.stringify({
    source_language: sourceLanguage,
    target_language: targetLanguage,
    strings: payload,
  }, null, 2);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function requestTranslations(entries, config, from, to) {
  const systemPrompt = [
    'You translate software interface localization strings.',
    'Return only a JSON object with this exact shape: {"translations":{"original.key":"translated text"}}.',
    'Return every input key exactly once and do not add keys.',
    'Translate only string values; never translate key names.',
    'Preserve {{placeholders}}, ${placeholders}, printf placeholders, URLs, HTML, Markdown, escape sequences, punctuation, and product names.',
    'Use concise, natural UI language and keep terminology consistent across the batch.',
  ].join(' ');

  let body = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: makePrompt(entries, from, to) },
    ],
    temperature: config.temperature,
  };
  if (config.jsonMode) body.response_format = { type: 'json_object' };
  body = adaptRequestBodyForProvider(body, config.provider, config.reasoningLevel);

  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...config.extraHeaders,
      };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        const details = (await response.text()).slice(0, 1500);
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${details}`);
      }

      const data = await response.json();
      const parsed = parseModelJson(extractResponseText(data));
      const translations = parsed?.translations;
      if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
        throw new Error('Model JSON has no translations object');
      }

      const expectedKeys = entries.map((entry) => entry.key).sort();
      const returnedKeys = Object.keys(translations).sort();
      if (JSON.stringify(expectedKeys) !== JSON.stringify(returnedKeys)) {
        throw new Error(`Model returned unexpected keys. Expected: ${expectedKeys.join(', ')}; got: ${returnedKeys.join(', ')}`);
      }

      for (const entry of entries) validateTranslation(entry, translations[entry.key]);
      return translations;
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxRetries) break;
      const retryDelay = Math.min(10_000, 750 * (2 ** attempt));
      console.warn(`Request failed (${error.message}). Retry ${attempt + 1}/${config.maxRetries} in ${retryDelay} ms...`);
      await sleep(retryDelay);
    }
  }
  throw lastError;
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function listLocaleCatalogs(localesRoot) {
  if (!fs.existsSync(localesRoot)) throw new Error(`Locales directory does not exist: ${localesRoot}`);
  return fs.readdirSync(localesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      locale: entry.name,
      file: path.join(localesRoot, entry.name, 'translation.json'),
    }))
    .filter((entry) => fs.existsSync(entry.file))
    .sort((a, b) => a.locale.localeCompare(b.locale, 'en'));
}

function createTranslationConfig(args, envFile) {
  const apiKey = (process.env.I18N_TRANSLATE_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const allowNoKey = /^(1|true|yes)$/i.test(process.env.I18N_TRANSLATE_ALLOW_NO_KEY || '');
  if (!apiKey && !allowNoKey) {
    throw new Error(`No API key. Put I18N_TRANSLATE_API_KEY into ${envFile} (or set I18N_TRANSLATE_ALLOW_NO_KEY=1 for a local server).`);
  }

  const apiUrl = normalizeChatCompletionsUrl(process.env.I18N_TRANSLATE_API_URL || 'https://api.openai.com/v1');
  const config = {
    apiKey,
    apiUrl,
    model: (process.env.I18N_TRANSLATE_MODEL || 'gpt-4o-mini').trim(),
    provider: resolveProvider(apiUrl, args.provider || process.env.I18N_TRANSLATE_PROVIDER),
    reasoningLevel: parseReasoningLevel(args.reasoning || process.env.I18N_TRANSLATE_REASONING_LEVEL),
    temperature: Number.parseFloat(process.env.I18N_TRANSLATE_TEMPERATURE || '0'),
    jsonMode: !/^(0|false|no)$/i.test(process.env.I18N_TRANSLATE_JSON_MODE || 'true'),
    extraHeaders: parseExtraHeaders(process.env.I18N_TRANSLATE_EXTRA_HEADERS || ''),
    maxRetries: parseNonNegativeInt(process.env.I18N_TRANSLATE_MAX_RETRIES, 3, 'I18N_TRANSLATE_MAX_RETRIES'),
    timeoutMs: parsePositiveInt(process.env.I18N_TRANSLATE_TIMEOUT_MS || '120000', 'I18N_TRANSLATE_TIMEOUT_MS'),
    delayMs: parseNonNegativeInt(process.env.I18N_TRANSLATE_DELAY_MS, 0, 'I18N_TRANSLATE_DELAY_MS'),
    batchSize: args.batchSize || parsePositiveInt(process.env.I18N_TRANSLATE_BATCH_SIZE || '1', 'I18N_TRANSLATE_BATCH_SIZE'),
  };
  if (!config.model) throw new Error('I18N_TRANSLATE_MODEL is empty');
  if (!Number.isFinite(config.temperature)) throw new Error('I18N_TRANSLATE_TEMPERATURE must be a number');
  return config;
}

async function translateChangelog({ args, file, sourceLocale, targetLocales, envFile }) {
  const changelog = readJson(file, 'changelog');
  const changes = changelog.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('Changelog must contain a changes object');
  }

  const source = changes[sourceLocale];
  if (!Array.isArray(source) || source.length === 0 || source.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`changes.${sourceLocale} must be a non-empty array of strings`);
  }

  let config;
  for (const targetLocale of targetLocales) {
    if (sourceLocale === targetLocale) continue;

    const existing = Array.isArray(changes[targetLocale]) ? changes[targetLocale].slice(0, source.length) : [];
    while (existing.length < source.length) existing.push('');

    let selected = source
      .map((text, index) => ({ key: `change_${index}`, source: text.trim(), index }))
      .filter((entry) => args.force || typeof existing[entry.index] !== 'string' || !existing[entry.index].trim());
    if (args.limit > 0) selected = selected.slice(0, args.limit);

    console.log(`\n[${targetLocale}] Changelog: ${path.relative(projectRoot, file)}`);
    console.log(`${args.force ? 'Selected' : 'Missing'}: ${selected.length} change(s)`);

    if (args.dryRun) {
      for (const entry of selected) console.log(`  ${entry.key}`);
      continue;
    }
    if (selected.length === 0) continue;

    if (!config) {
      config = createTranslationConfig(args, envFile);
      console.log(`Provider: ${config.provider}; reasoning: ${config.reasoningLevel}; batch size: ${config.batchSize}`);
    }

    let completed = 0;
    const batches = chunk(selected, config.batchSize);
    for (const batch of batches) {
      const translations = await requestTranslations(batch, config, sourceLocale, targetLocale);
      for (const entry of batch) existing[entry.index] = translations[entry.key];
      completed += batch.length;
      if (completed < selected.length) await sleep(config.delayMs);
    }

    changes[targetLocale] = existing;
    saveJson(file, changelog);
    console.log(`Done: wrote ${completed} change(s) to changes.${targetLocale}`);
  }
}

async function translateCatalog({
  args,
  sourceEntries,
  sourceLocale,
  targetLocale,
  targetFile,
  getConfig,
}) {
  const targetExists = fs.existsSync(targetFile);
  const target = targetExists ? readJson(targetFile, 'target') : {};
  let selected = sourceEntries.filter((entry) => {
    if (args.force) return true;
    const current = getPath(target, entry.path);
    return !current.exists || typeof current.value !== 'string' || current.value.trim() === '';
  });
  if (args.limit > 0) selected = selected.slice(0, args.limit);

  const copiedEntries = selected.filter((entry) => isUrlOnly(entry.source));
  const pending = selected.filter((entry) => !isUrlOnly(entry.source));

  console.log(`\n[${targetLocale}] Target: ${path.relative(projectRoot, targetFile)} (${targetExists ? 'existing' : 'will be created'})`);
  console.log(`${args.force ? 'Selected' : 'Missing'}: ${selected.length} strings (${pending.length} API, ${copiedEntries.length} copied)`);

  if (args.dryRun) {
    for (const entry of selected) console.log(`  ${isUrlOnly(entry.source) ? '[copy] ' : ''}${entry.key}`);
    return { translated: 0, copied: 0, selected: selected.length };
  }

  if (!targetExists) saveJson(targetFile, target);

  if (copiedEntries.length > 0) {
    for (const entry of copiedEntries) setPath(target, entry.path, entry.source);
    saveJson(targetFile, target);
    console.log(`Copied ${copiedEntries.length} URL-only strings without API calls.`);
  }

  if (pending.length === 0) {
    return { translated: 0, copied: copiedEntries.length, selected: selected.length };
  }

  const config = getConfig();
  const batches = chunk(pending, config.batchSize);
  let completed = 0;
  for (const batch of batches) {
    const names = batch.map((entry) => entry.key).join(', ');
    console.log(`[${targetLocale} ${completed + 1}-${completed + batch.length}/${pending.length}] ${names}`);
    const translations = await requestTranslations(batch, config, sourceLocale, targetLocale);
    for (const entry of batch) setPath(target, entry.path, translations[entry.key]);
    saveJson(targetFile, target);
    completed += batch.length;
    if (completed < pending.length) await sleep(config.delayMs);
  }

  console.log(`Done: wrote ${completed + copiedEntries.length} strings to ${path.relative(projectRoot, targetFile)}`);
  return { translated: completed, copied: copiedEntries.length, selected: selected.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.all && (args.to || args.target)) {
    throw new Error('--all cannot be combined with --to or --target');
  }

  const sourceLocale = args.from || (args.all ? 'en' : 'ru');
  const targetLocale = args.to || 'en';
  const localesRoot = path.resolve(projectRoot, args.locales || 'i18n/locales');
  const envFile = path.resolve(projectRoot, args.env || '.env.i18n');
  loadEnvFile(envFile);

  if (args.changelog) {
    if (args.source || args.target) {
      throw new Error('--changelog cannot be combined with --source or --target');
    }
    const targetLocales = args.all
      ? listLocaleCatalogs(localesRoot).map((entry) => entry.locale)
      : [targetLocale];
    await translateChangelog({
      args,
      file: path.resolve(projectRoot, args.changelog),
      sourceLocale,
      targetLocales,
      envFile,
    });
    return;
  }

  const sourceFile = path.resolve(projectRoot, args.source || path.join(localesRoot, sourceLocale, 'translation.json'));
  if (!fs.existsSync(sourceFile)) throw new Error(`Source catalog does not exist: ${sourceFile}`);

  const source = readJson(sourceFile, 'source');
  const sourceEntries = flattenStrings(source);
  console.log(`Source: ${path.relative(projectRoot, sourceFile)} (${sourceEntries.length} strings)`);

  const targets = args.all
    ? listLocaleCatalogs(localesRoot).filter((entry) => entry.locale.toLowerCase() !== sourceLocale.toLowerCase())
    : [{
        locale: targetLocale,
        file: path.resolve(projectRoot, args.target || path.join(localesRoot, targetLocale, 'translation.json')),
      }];
  if (targets.length === 0) throw new Error('No target locale catalogs found');
  if (targets.some((target) => path.resolve(target.file) === path.resolve(sourceFile))) {
    throw new Error('Source and target catalogs must be different files');
  }

  let config;
  const getConfig = () => {
    if (!config) {
      config = createTranslationConfig(args, envFile);
      console.log(`Provider: ${config.provider}; reasoning: ${config.reasoningLevel}; batch size: ${config.batchSize}`);
    }
    return config;
  };

  let translated = 0;
  let copied = 0;
  for (const target of targets) {
    const result = await translateCatalog({
      args,
      sourceEntries,
      sourceLocale,
      targetLocale: target.locale,
      targetFile: target.file,
      getConfig,
    });
    translated += result.translated;
    copied += result.copied;
  }

  if (args.all) {
    console.log(`\nAll locales complete: ${targets.length} catalogs, ${translated} translated, ${copied} URL-only strings copied.`);
  }
}

main().catch((error) => {
  console.error(`i18n translation failed: ${error.message}`);
  process.exitCode = 1;
});
