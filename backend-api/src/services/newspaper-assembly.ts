/**
 * Incremental newspaper assembly: the editor agent builds the issue through tools
 * instead of emitting one giant JSON document.
 *
 *   add_blocks({ blocks: [...] })    — validated immediately, appended to the draft
 *   finalize_issue({ title, ... })   — final whole-document check, closes assembly
 *
 * Every tool call runs each block through the same validator as stored documents,
 * so invalid material is rejected in the loop with actionable feedback while the
 * editor can still fix it. Validated blocks survive an editor crash because the
 * caller persists the draft after every successful call.
 */

import { validateNewspaperBlock, validateNewspaperDocument } from './newspapers.js';
import type { AgentTool } from './agent-runner.js';
import type { NewspaperBlock, NewspaperIssueDocument } from '../types.js';

const MAX_BLOCKS_PER_ISSUE = 80;

export type AssemblyMeta = {
  title: string;
  subtitle?: string;
};

export type AssemblyState = {
  date: string;
  blocks: NewspaperBlock[];
  ids: Set<string>;
  meta: AssemblyMeta | null;
};

export type AssemblyTools = {
  state: AssemblyState;
  tools: AgentTool[];
  /** Whole-document validation of everything assembled so far; throws with reasons. */
  buildDocument: (fallbackTitle?: string) => NewspaperIssueDocument;
};

export type CreateAssemblyToolsOptions = {
  date: string;
  /** Called after every successful add_blocks with the current draft shape. */
  onBlocksChanged?: (draft: { version: 1; date: string; blocks: NewspaperBlock[] }) => Promise<void> | void;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Human-readable version of a per-block validator error, for tool feedback. */
const describeBlockProblem = (code: string): string => {
  let match = code.match(/^invalid_newspaper_block_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: unknown "type"; must be one of article, note, notes_list, weather, image ("hero" is an article role, never a type)`;
  match = code.match(/^invalid_newspaper_block_id_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: "id" is missing, empty, or already used by an earlier block; every block needs a unique non-empty id`;
  match = code.match(/^invalid_article_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: article requires non-empty "title", non-empty "text", and "role" of hero, feature, or standard`;
  match = code.match(/^invalid_note_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: note must contain at least one of title, text, url, image_url`;
  match = code.match(/^invalid_notes_list_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: notes_list requires an "items" array with 1 to 40 items`;
  match = code.match(/^invalid_note_item_(\d+)_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}, item ${Number(match[2]) + 1}: item must have at least one of id, title, text, url, image_url`;
  match = code.match(/^invalid_weather_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: weather requires non-empty "location", non-empty "condition", and a "periods" array with 1 to 14 items`;
  match = code.match(/^invalid_weather_period_(\d+)_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}, period ${Number(match[2]) + 1}: period requires non-empty "label" and a numeric "temperature"`;
  match = code.match(/^invalid_image_(\d+)$/);
  if (match) return `block ${Number(match[1]) + 1}: image block requires a non-empty "title"`;
  return code;
};

const blockShapeDescription = `Block shapes (exactly five types; "hero" is an article role, never a type):
- article: { "id": "unique string", "type": "article", "role": "hero | feature | standard", "title": "string", "text": "string", "long_text": "optional expanded reader version shown when the item is opened individually", "url": "optional direct URL", "image_url": "optional exact image URL", "sources": [{ "title": "string", "url": "direct URL" }] }
- note: { "id": "unique string", "type": "note", "title": "optional string", "text": "optional string", "long_text": "optional expanded reader version", "url": "optional direct URL", "image_url": "optional exact image URL", "sources": [{ "title": "string", "url": "direct URL" }] }
- notes_list: { "id": "unique string", "type": "notes_list", "title": "optional string", "items": [{ "id": "optional string", "title": "optional string", "text": "optional string", "long_text": "optional expanded reader version", "url": "optional direct URL", "image_url": "optional exact image URL", "sources": [{ "title": "string", "url": "direct URL" }] }] }
- weather: { "id": "unique string", "type": "weather", "title": "optional string", "location": "string", "condition": "string", "details": "optional string", "periods": [{ "label": "string", "temperature": 0, "condition": "optional string" }] }
- image: { "id": "unique string", "type": "image", "title": "string", "image_url": "optional URL", "caption": "optional string", "prompt": "optional string" }`;

export const createAssemblyTools = (options: CreateAssemblyToolsOptions): AssemblyTools => {
  const state: AssemblyState = { date: options.date, blocks: [], ids: new Set(), meta: null };

  const buildDocument = (fallbackTitle?: string): NewspaperIssueDocument => {
    const meta = state.meta || (fallbackTitle ? { title: fallbackTitle } : null);
    if (!meta) throw new Error('issue_not_finalized');
    return validateNewspaperDocument({
      version: 1,
      title: meta.title,
      ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
      date: state.date,
      blocks: state.blocks,
    });
  };

  const addBlocks: AgentTool = {
    definition: {
      type: 'function',
      function: {
        name: 'add_blocks',
        description: `Append newspaper blocks to the issue draft. Every block is validated immediately: invalid blocks are rejected with the reason, valid ones are saved to the draft and survive any interruption. Pass several related blocks per call (for example all briefs of one theme), not the entire issue at once. Blocks are appended in editorial order; blocks cannot be modified or removed after being accepted, so send final text only.
${blockShapeDescription}`,
        parameters: {
          type: 'object',
          properties: {
            blocks: {
              type: 'array',
              description: 'Blocks to append, in editorial order.',
              items: { type: 'object' },
            },
          },
          required: ['blocks'],
        },
      },
    },
    handler: async (args) => {
      const incoming = Array.isArray(args?.blocks) ? args.blocks : null;
      if (!incoming || incoming.length === 0) {
        return JSON.stringify({ status: 'error', message: 'blocks must be a non-empty array' });
      }
      if (state.blocks.length + incoming.length > MAX_BLOCKS_PER_ISSUE) {
        return JSON.stringify({
          status: 'error',
          message: `issue cannot exceed ${MAX_BLOCKS_PER_ISSUE} blocks in total; already added ${state.blocks.length}`,
        });
      }

      // Validate the whole incoming batch on a scratch copy of the id set first:
      // a batch is accepted atomically or rejected with per-block reasons.
      const batchIds = new Set(state.ids);
      const accepted: NewspaperBlock[] = [];
      const problems: string[] = [];
      incoming.forEach((source: unknown, index: number) => {
        try {
          accepted.push(validateNewspaperBlock(source, state.blocks.length + index, batchIds));
        } catch (error) {
          problems.push(describeBlockProblem(errorText(error)));
        }
      });
      if (problems.length > 0) {
        return JSON.stringify({
          status: 'error',
          message: 'rejected: no blocks from this call were added; fix the listed problems and retry the corrected blocks',
          problems,
          added_so_far: state.blocks.length,
        });
      }

      for (const block of accepted) state.blocks.push(block);
      state.ids = batchIds;
      await options.onBlocksChanged?.({ version: 1, date: state.date, blocks: state.blocks });
      return JSON.stringify({
        status: 'success',
        added: accepted.length,
        total_blocks: state.blocks.length,
        block_ids: accepted.map(block => block.id),
      });
    },
  };

  const finalizeIssue: AgentTool = {
    definition: {
      type: 'function',
      function: {
        name: 'finalize_issue',
        description: `Finish the issue after all blocks have been added: sets the issue title and optional subtitle, runs the final whole-document check, and publishes the issue. The issue date is set automatically. Requires at least one previously accepted block and a non-empty title. Call this exactly once as your final action.`,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Issue title, non-empty.' },
            subtitle: { type: 'string', description: 'Optional issue subtitle.' },
          },
          required: ['title'],
        },
      },
    },
    handler: async (args) => {
      if (state.meta) {
        return JSON.stringify({ status: 'error', message: 'issue is already finalized' });
      }
      const title = typeof args?.title === 'string' ? args.title.trim().slice(0, 240) : '';
      const subtitle = typeof args?.subtitle === 'string' ? args.subtitle.trim().slice(0, 500) : '';
      if (!title) {
        return JSON.stringify({ status: 'error', message: 'title must be a non-empty string' });
      }
      if (state.blocks.length === 0) {
        return JSON.stringify({
          status: 'error',
          message: 'cannot finalize an empty issue: add blocks with add_blocks first (at least one accepted block is required)',
        });
      }
      state.meta = { title, ...(subtitle ? { subtitle } : {}) };
      try {
        const document = buildDocument();
        return JSON.stringify({
          status: 'success',
          message: 'issue finalized',
          title: document.title,
          blocks: document.blocks.length,
        });
      } catch (error) {
        state.meta = null;
        return JSON.stringify({
          status: 'error',
          message: `final validation failed: ${describeBlockProblem(errorText(error))}`,
          total_blocks: state.blocks.length,
        });
      }
    },
  };

  return { state, tools: [addBlocks, finalizeIssue], buildDocument };
};
