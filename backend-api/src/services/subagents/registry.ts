/**
 * Subagent registry — maps agent names to their configurations.
 *
 * To add a new subagent:
 * 1. Create tools in    tools/<name>-tools.ts
 * 2. Create prompt in   prompts/<name>.md with name_key/description_key metadata.
 *    Add those keys to src/i18n/locales/en and ru/translation.json.
 * 3. Add entry to REGISTRY below
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { hasBackendTextTranslation, translateForLanguage } from '../../i18n/index.js';
import { parseSubagentPrompt, type SubagentPromptDocument } from './prompt-metadata.js';

import { SubagentConfig } from './types.js';
import { fileConverterTools } from './tools/file-converter-tools.js';
import { readWebpageTool, searchWebTool } from '../tools/registry.js';

// ---------------------------------------------------------------------------
// Prompt loader
// ---------------------------------------------------------------------------

// In dev __dirname = .../src/services/subagents (ts-node / tsx)
// In prod __dirname = .../dist/services/subagents (compiled)
// Prompts live in src/services/subagents/prompts/ and are NOT copied to dist by tsc.
// Resolve relative to src/ — try dist→src fallback.
const SRC_PROMPTS_DIR = join(__dirname, '..', '..', '..', 'src', 'services', 'subagents', 'prompts');
const LOCAL_PROMPTS_DIR = join(__dirname, 'prompts');

const promptCache = new Map<string, SubagentPromptDocument>();

function loadPrompt(filename: string): SubagentPromptDocument {
  const cached = promptCache.get(filename);
  if (cached) return cached;
  let content: string;
  try { content = readFileSync(join(LOCAL_PROMPTS_DIR, filename), 'utf-8'); }
  catch { content = readFileSync(join(SRC_PROMPTS_DIR, filename), 'utf-8'); }
  const document = parseSubagentPrompt(content);
  promptCache.set(filename, document);
  return document;
}

/** Clear cached prompts (useful after updating prompt files at runtime). */
export function clearPromptCache(): void {
  promptCache.clear();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Record<string, SubagentConfig> = {
  news_researcher: {
    name: 'news_researcher',
    description: 'Researches one focused newspaper topic using web search and webpage reading, then returns a concise source-grounded dossier.',
    promptFile: 'news-researcher.md',
    tools: [searchWebTool, readWebpageTool],
    sharedTools: ['describe_image'],
    maxLoops: 20,
    maxTokens: 16_384,
  },
  file_converter: {
    name: 'file_converter',
    description: 'Converts local files through the desktop application. Currently supports video only and must refuse audio, document, or any other operation that has no dedicated tool without taking action.',
    promptFile: 'file-converter.md',
    tools: fileConverterTools,
    maxLoops: 8,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RegisteredSubagent extends SubagentConfig {
  /** Loaded system prompt text (from file or direct). */
  systemPrompt: string;
}

/** Get a subagent config by name. Throws if not found. */
export function getSubagent(name: string): RegisteredSubagent {
  const config = REGISTRY[name];
  if (!config) {
    throw new Error(`Unknown subagent: ${name}`);
  }
  return {
    ...config,
    systemPrompt: loadPrompt(config.promptFile!).body,
  };
}

/** Report configuration mistakes at startup while keeping legacy fallbacks available. */
export function validateSubagentCatalogMetadata(hasText = hasBackendTextTranslation): string[] {
  const issues: string[] = [];
  for (const config of Object.values(REGISTRY)) {
    const source = `${config.name} (${config.promptFile || 'no prompt file'})`;
    try {
      const metadata = config.promptFile ? loadPrompt(config.promptFile).metadata : undefined;
      if (!metadata) {
        issues.push(`${source}: missing name_key/description_key metadata`);
        continue;
      }
      for (const key of [metadata.nameKey, metadata.descriptionKey]) {
        if (!hasText(key)) issues.push(`${source}: missing or empty English text translation "${key}"`);
      }
    } catch (error) {
      issues.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return issues;
}

/** Localized display metadata from prompt headers; prompts and tool settings stay private. */
export function listSubagentCatalog(language: unknown = 'en'): Array<{ id: string; name: string; description: string; icon: string }> {
  return Object.values(REGISTRY).map(config => {
    const metadata = config.promptFile ? loadPrompt(config.promptFile).metadata : undefined;
    const translate = (key: string | undefined, fallback: string) => key && hasBackendTextTranslation(key)
      ? translateForLanguage(language, key)
      : fallback;
    return {
      id: config.name,
      icon: metadata?.icon || 'agent',
      name: translate(metadata?.nameKey, config.name.replace(/_/g, ' ')),
      description: translate(metadata?.descriptionKey, config.description),
    };
  });
}

/** List all registered subagent names. */
export function listSubagentNames(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Build an ad-hoc subagent from a direct system prompt (no file, direct tools omitted).
 * Used by the `spawn_subagent` tool — the main agent creates a subagent on the fly.
 */
export function buildAdhocSubagent(opts: {
  name?: string;
  systemPrompt: string;
  sharedTools: string[];
  maxLoops: number;
}): RegisteredSubagent {
  return {
    name: opts.name || 'adhoc',
    description: 'Ad-hoc subagent created by the main agent.',
    systemPromptText: opts.systemPrompt,
    systemPrompt: opts.systemPrompt,
    sharedTools: opts.sharedTools,
    tools: [],
    maxLoops: opts.maxLoops,
  };
}

/**
 * Build a description string for the main agent listing available subagents.
 * Used in the invoke_subagent tool description.
 */
export function buildSubagentListDescription(): string {
  const entries = Object.values(REGISTRY).map(
    (cfg) => `"${cfg.name}" — ${cfg.description}`
  );
  return entries.join('\n');
}
