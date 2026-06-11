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

const PROMPTS_DIR = join(__dirname, 'prompts');

const promptCache = new Map<string, string>();

function loadPrompt(filename: string): string {
  const cached = promptCache.get(filename);
  if (cached) return cached;

  const filePath = join(PROMPTS_DIR, filename);
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
  /** Loaded system prompt text. */
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
    systemPrompt: loadPrompt(config.promptFile),
  };
}

/** List all registered subagent names. */
export function listSubagentNames(): string[] {
  return Object.keys(REGISTRY);
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
