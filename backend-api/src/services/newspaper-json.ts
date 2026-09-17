/**
 * Newspaper editor JSON pipeline: parse -> deterministic repair -> LLM repair -> validate.
 *
 * The editor agent sometimes returns JSON with typical LLM serialization mistakes:
 * markdown fences, missing/extra commas, truncated output, or schema violations
 * (wrong block type, missing required fields). Throwing on the first mistake used to
 * discard a finished run together with all researcher work, so every failure mode is
 * handled here instead:
 *
 *   1. plain JSON.parse
 *   2. jsonrepair (fences, commas, quotes, junk around JSON, truncation)
 *   3. structural validation via validateNewspaperDocument (the schema authority)
 *   4. up to N tiny model calls that fix ONLY the reported problems
 *   5. throw a descriptive error; the caller keeps the raw editor output
 */

import { jsonrepair } from 'jsonrepair';
import { runAgent, type RunAgentResult } from './agent-runner.js';
import { validateNewspaperDocument } from './newspapers.js';
import type { MessageUsage, NewspaperIssueDocument, TokenUsageCall } from '../types.js';

export const MAX_LLM_REPAIR_ATTEMPTS = 2;

export type RepairStage = 'direct_parse' | 'jsonrepair' | 'llm_repair';
export type RepairProblemKind = 'syntax' | 'schema';

export type RepairAttempt = {
  stage: RepairStage;
  attempt?: number;
  ok: boolean;
  problems: string[];
};

export type RepairProgress = {
  stage: RepairStage;
  attempt?: number;
  kind: RepairProblemKind;
  problems: string[];
};

export type LlmRepairInput = {
  raw: string;
  problems: string[];
  attempt: number;
  maxAttempts: number;
};

export type ParseRepairAndValidateOptions = {
  /** Server-side local date forced onto the document (same behaviour as the runner). */
  date: string;
  /** Required only when the default model-based repair is used. */
  userId?: number;
  signal?: AbortSignal;
  maxLlmAttempts?: number;
  /** Injectable model call for tests; defaults to a tool-less runAgent call. */
  llmRepair?: (input: LlmRepairInput) => Promise<string>;
  onProgress?: (progress: RepairProgress) => Promise<void> | void;
};

export type ParseRepairAndValidateResult = {
  document: NewspaperIssueDocument;
  attempts: RepairAttempt[];
  llmRepairUsage: MessageUsage | null;
};

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Maps terse validator error codes to instructions a repair model can act on. */
const describeSchemaProblem = (code: string): string => {
  let match = code.match(/^invalid_newspaper_block_(\d+)$/);
  if (match) return `blocks[${match[1]}]: unknown "type"; must be one of article, note, notes_list, weather, image ("hero" is an article role, never a type)`;
  match = code.match(/^invalid_newspaper_block_id_(\d+)$/);
  if (match) return `blocks[${match[1]}]: "id" is missing, empty, or duplicates an earlier block id; every block needs a unique non-empty id string`;
  match = code.match(/^invalid_article_(\d+)$/);
  if (match) return `blocks[${match[1]}]: article requires non-empty "title", non-empty "text", and "role" of hero, feature, or standard`;
  match = code.match(/^invalid_note_(\d+)$/);
  if (match) return `blocks[${match[1]}]: note must contain at least one of title, text, url, image_url`;
  match = code.match(/^invalid_notes_list_(\d+)$/);
  if (match) return `blocks[${match[1]}]: notes_list requires an "items" array with 1 to 40 items`;
  match = code.match(/^invalid_note_item_(\d+)_(\d+)$/);
  if (match) return `blocks[${match[1]}].items[${match[2]}]: item must be an object with at least one of id, title, text, url, image_url`;
  match = code.match(/^invalid_weather_(\d+)$/);
  if (match) return `blocks[${match[1]}]: weather requires non-empty "location", non-empty "condition", and a "periods" array with 1 to 14 items`;
  match = code.match(/^invalid_weather_period_(\d+)_(\d+)$/);
  if (match) return `blocks[${match[1]}].periods[${match[2]}]: period requires non-empty "label" and a numeric "temperature"`;
  match = code.match(/^invalid_image_(\d+)$/);
  if (match) return `blocks[${match[1]}]: image block requires a non-empty "title"`;
  if (code === 'invalid_newspaper_document') {
    return 'root object must be { "version": 1, "title": string, "subtitle"?: string, "date": string, "blocks": non-empty array (max 80) }';
  }
  return code;
};

const repairSystemPrompt = `You are a JSON repair specialist inside a personal newspaper pipeline.
The newspaper editor produced output that is either syntactically invalid JSON or violates the newspaper schema.

Fix ONLY the reported problems. Do not rewrite, translate, summarize, condense, add, remove, or reorder content.
Keep every block, id, title, text, url, image_url, source, and the block order exactly as provided.
Only change what the reported problems require, for example: closing truncated JSON, fixing commas and quotes, correcting a block "type", filling a required field from the block's own content, or making ids unique.

Required document contract:
{
  "version": 1,
  "title": "string",
  "subtitle": "optional string",
  "date": "string",
  "blocks": [
    { "id": "unique string", "type": "article", "role": "hero | feature | standard", "title": "string", "text": "string", "url": "optional URL", "image_url": "optional URL", "sources": [{ "title": "string", "url": "URL" }] },
    { "id": "unique string", "type": "note", "title": "optional string", "text": "optional string", "url": "optional URL", "image_url": "optional URL" },
    { "id": "unique string", "type": "notes_list", "title": "optional string", "items": [{ "id": "optional string", "title": "optional string", "text": "optional string", "url": "optional URL", "image_url": "optional URL" }] },
    { "id": "unique string", "type": "weather", "title": "optional string", "location": "string", "condition": "string", "details": "optional string", "periods": [{ "label": "string", "temperature": 0, "condition": "optional string" }] },
    { "id": "unique string", "type": "image", "title": "string", "image_url": "optional URL", "caption": "optional string", "prompt": "optional string" }
  ]
}

There are exactly five block types: article, note, notes_list, weather, image. "hero" is an article role, never a block type.

Return exactly one valid JSON object and nothing else: no markdown fences, no commentary.`;

const sumCalls = (calls: TokenUsageCall[]) => calls.reduce((sum, call) => ({
  prompt_tokens: sum.prompt_tokens + call.prompt_tokens,
  completion_tokens: sum.completion_tokens + call.completion_tokens,
  total_tokens: sum.total_tokens + call.total_tokens,
  cache_hit_tokens: sum.cache_hit_tokens + call.cache_hit_tokens,
  cache_miss_tokens: sum.cache_miss_tokens + call.cache_miss_tokens,
  reasoning_tokens: sum.reasoning_tokens + call.reasoning_tokens,
}), {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cache_hit_tokens: 0,
  cache_miss_tokens: 0,
  reasoning_tokens: 0,
});

const mergeUsage = (usages: Array<RunAgentResult['usage']>): MessageUsage | null => {
  const present = usages.filter((usage): usage is MessageUsage => !!usage);
  if (present.length === 0) return null;
  const calls = present.flatMap(usage => usage.calls);
  const latest = calls[calls.length - 1];
  return {
    latest: {
      prompt_tokens: latest.prompt_tokens,
      completion_tokens: latest.completion_tokens,
      total_tokens: latest.total_tokens,
      cache_hit_tokens: latest.cache_hit_tokens,
      cache_miss_tokens: latest.cache_miss_tokens,
      reasoning_tokens: latest.reasoning_tokens,
    },
    aggregate: sumCalls(calls),
    calls,
  };
};

/**
 * Direct parse first; then jsonrepair (fences, commas, quotes, truncation);
 * then brace-slicing for prose wrapped around the JSON. Prefers object results:
 * jsonrepair can turn surrounding prose into a parseable-but-useless array.
 */
const parseText = (text: string): { value?: unknown; problems: string[] } => {
  const problems: string[] = [];
  const candidates: string[] = [];
  try {
    candidates.push(jsonrepair(text));
  } catch (error) {
    problems.push(`jsonrepair: ${errorText(error)}`);
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = text.slice(start, end + 1);
    candidates.push(sliced);
    if (sliced !== text) {
      try {
        candidates.push(jsonrepair(sliced));
      } catch {
        // The sliced candidate failing jsonrepair is covered by its own parse attempt.
      }
    }
  } else {
    problems.push('no JSON object found in editor output');
  }

  try {
    return { value: JSON.parse(text), problems: [] };
  } catch (error) {
    problems.unshift(errorText(error));
  }
  let fallback: unknown;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (isRecord(value)) return { value, problems: [] };
      if (fallback === undefined) fallback = value;
    } catch (error) {
      problems.push(errorText(error));
    }
  }
  if (fallback !== undefined) return { value: fallback, problems: [] };
  return { problems };
};

/**
 * Single entry point for the runner:
 * parse, deterministically repair, validate, and as a last resort ask a model to fix
 * only the reported problems (2 attempts by default). Throws a descriptive aggregate
 * error when everything fails; the caller is expected to keep the raw editor output
 * for manual recovery.
 */
export const parseRepairAndValidateNewspaper = async (
  raw: string,
  options: ParseRepairAndValidateOptions,
): Promise<ParseRepairAndValidateResult> => {
  const maxLlmAttempts = Math.max(0, Math.floor(options.maxLlmAttempts ?? MAX_LLM_REPAIR_ATTEMPTS));
  if (!raw.trim()) throw new Error('newspaper_editor_json_invalid_after_repairs: editor returned empty output');
  const attempts: RepairAttempt[] = [];
  const repairUsages: Array<RunAgentResult['usage']> = [];

  const llmRepair = async (input: LlmRepairInput): Promise<string> => {
    if (options.llmRepair) return options.llmRepair(input);
    if (options.userId == null) throw new Error('user_required_for_newspaper_llm_repair');
    const result = await runAgent({
      userId: options.userId,
      name: 'newspaper_json_repair',
      systemPrompt: repairSystemPrompt,
      input: [
        `Problems found (attempt ${input.attempt} of ${input.maxAttempts}):`,
        ...input.problems.map(problem => `- ${problem}`),
        '',
        '<raw editor output>',
        input.raw,
        '</raw editor output>',
        '',
        'Return the full corrected JSON object and nothing else.',
      ].join('\n'),
      tools: [],
      maxLoops: 4,
      maxTokens: 24_576,
      signal: options.signal,
    });
    repairUsages.push(result.usage);
    return result.finalText;
  };

  const initial = parseText(raw);
  attempts.push({ stage: 'direct_parse', ok: initial.value !== undefined, problems: initial.problems });
  attempts.push({
    stage: 'jsonrepair',
    ok: initial.value !== undefined,
    problems: initial.value === undefined ? initial.problems : [],
  });

  let current = initial.value === undefined ? raw : JSON.stringify(initial.value);
  let parsed = initial.value;
  let problems = initial.problems;
  let kind: RepairProblemKind = 'syntax';

  for (let attempt = 0; ; attempt++) {
    if (parsed !== undefined) {
      try {
        const document = validateNewspaperDocument({ ...(isRecord(parsed) ? parsed : {}), date: options.date });
        return { document, attempts, llmRepairUsage: mergeUsage(repairUsages) };
      } catch (error) {
        problems = [describeSchemaProblem(errorText(error))];
        kind = 'schema';
        current = JSON.stringify(parsed);
      }
    }
    if (attempt >= maxLlmAttempts) break;

    await options.onProgress?.({ stage: 'llm_repair', attempt: attempt + 1, kind, problems });
    const repairedRaw = await llmRepair({ raw: current, problems, attempt: attempt + 1, maxAttempts: maxLlmAttempts });
    const reparsed = parseText(repairedRaw);
    attempts.push({
      stage: 'llm_repair',
      attempt: attempt + 1,
      ok: reparsed.value !== undefined,
      problems: reparsed.problems,
    });
    if (reparsed.value !== undefined) {
      current = JSON.stringify(reparsed.value);
      parsed = reparsed.value;
      problems = [];
      kind = 'schema';
    } else {
      parsed = undefined;
      problems = reparsed.problems;
      kind = 'syntax';
    }
  }

  const failed = attempts
    .filter(item => !item.ok)
    .map(item => `${item.stage}${item.attempt != null ? ` #${item.attempt}` : ''}: ${item.problems.join('; ')}`);
  throw new Error(`newspaper_editor_json_invalid_after_repairs: ${[...failed, ...problems].join(' | ')}`);
};
