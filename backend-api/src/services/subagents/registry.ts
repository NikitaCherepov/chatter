/**
 * Subagent registry — maps agent names to their configurations.
 *
 * To add a new subagent:
 * 1. Create tools in    tools/<name>-tools.ts
 * 2. Create prompt in   prompts/<name>.md
 * 3. Add entry to REGISTRY below
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { SubagentConfig } from './types.js';

// ---------------------------------------------------------------------------
// Prompt loader
// ---------------------------------------------------------------------------

// In dev __dirname = .../src/services/subagents (ts-node / tsx)
// In prod __dirname = .../dist/services/subagents (compiled)
// Prompts live in src/services/subagents/prompts/ and are NOT copied to dist by tsc.
// Resolve relative to src/ — try dist→src fallback.
const SRC_PROMPTS_DIR = join(__dirname, '..', '..', '..', 'src', 'services', 'subagents', 'prompts');
const LOCAL_PROMPTS_DIR = join(__dirname, 'prompts');

const promptCache = new Map<string, string>();

function loadPrompt(filename: string): string {
  const cached = promptCache.get(filename);
  if (cached) return cached;

  // Try local first (if running from src), then src-relative (if running from dist)
  let filePath = join(LOCAL_PROMPTS_DIR, filename);
  try {
    const content = readFileSync(filePath, 'utf-8');
    promptCache.set(filename, content);
    return content;
  } catch {}

  filePath = join(SRC_PROMPTS_DIR, filename);
  const content = readFileSync(filePath, 'utf-8');
  promptCache.set(filename, content);
  return content;
}

/** Clear cached prompts (useful after updating prompt files at runtime). */
export function clearPromptCache(): void {
  promptCache.clear();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Record<string, SubagentConfig> = {
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
    systemPrompt: loadPrompt(config.promptFile!),
  };
}

/** List all registered subagent names. */
export function listSubagentNames(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Build an ad-hoc subagent from a direct system prompt (no file, no ownTools).
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
    ownTools: [],
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
