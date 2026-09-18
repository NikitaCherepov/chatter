import { getNewspaperIssue, listNewspaperIssues, listNewspapers } from '../newspapers.js';
import { describeNewspaperBlockLines, findNewspaperMaterial, resolveCurrentIssueFromChat } from '../newspaper-chat.js';
import type { NewspaperIssueDto } from '../../types.js';
import type { Tool } from './types.js';

/**
 * Newspaper browsing tools — available in every chat so the assistant can
 * deliberately search the reader's newspapers and read their issues.
 *
 * "Current issue" resolution works only inside the temporary newspaper-reader
 * chat, where send-time [ACTIVE_VIEW] markers record what the reader has
 * open. Everywhere else the assistant passes newspaper_id explicitly.
 */

const NO_CURRENT_ISSUE = 'No newspaper issue is currently open by the reader in this chat. Pass newspaper_id explicitly (see newspapers_list) or ask the reader to open the newspaper.';

const resolveIssue = (userId: number, newspaperId: number | null, chatId: number | undefined): { issue: NewspaperIssueDto | null; error?: string } => {
  if (newspaperId !== null) {
    const issues = listNewspaperIssues(userId, newspaperId, 1);
    if (issues.length === 0) return { issue: null, error: `Newspaper ${newspaperId} not found or has no issues. Call newspapers_list for valid ids.` };
    return { issue: getNewspaperIssue(userId, issues[0].id) };
  }
  if (chatId === undefined) return { issue: null, error: NO_CURRENT_ISSUE };
  const currentIssueId = resolveCurrentIssueFromChat(chatId);
  if (currentIssueId === null) return { issue: null, error: NO_CURRENT_ISSUE };
  const issue = getNewspaperIssue(userId, currentIssueId);
  if (!issue) return { issue: null, error: 'The currently open issue is no longer available. Call newspapers_list.' };
  return { issue };
};

export const newspapersListTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'newspapers_list',
      description: 'List the reader\'s personal newspapers with their latest issues (ids, numbers, dates). Start here when deliberately browsing newspapers. Do not call it when a newspaper issue is already visible in the context above.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  handler: async (_args, context) => {
    const newspapers = listNewspapers(context.userId);
    if (newspapers.length === 0) return 'The reader has no newspapers yet.';
    const lines = newspapers.map(newspaper =>
      `- newspaper_id ${newspaper.id}: "${newspaper.name}"`
      + (newspaper.latest_issue
        ? ` — latest issue #${newspaper.latest_issue.issue_number} "${newspaper.latest_issue.title}" (issue_id ${newspaper.latest_issue.id}, ${newspaper.latest_issue.published_at})`
        : ' — no issues yet'),
    );
    return `The reader's newspapers:\n${lines.join('\n')}\nUse newspaper_issue_contents to list the items of an issue.`;
  },
};

export const newspaperIssueContentsTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'newspaper_issue_contents',
      description: 'List all items of a newspaper issue with their ids and titles (articles, notes, weather, images). Without newspaper_id, uses the issue the reader currently has open. Do not call it when the issue contents are already visible in the context above.',
      parameters: {
        type: 'object',
        properties: {
          newspaper_id: { type: 'number', description: 'Newspaper id from newspapers_list. Omit to use the currently open issue.' },
        },
      },
    },
  },
  handler: async (args, context) => {
    const newspaperId = Number.isFinite(Number(args.newspaper_id)) && Number(args.newspaper_id) > 0 ? Number(args.newspaper_id) : null;
    const { issue, error } = resolveIssue(context.userId, newspaperId, context.chatId);
    if (error) return error;
    if (!issue) return 'Issue not found. Call newspapers_list for valid ids.';
    const lines = issue.document.blocks.flatMap(block => describeNewspaperBlockLines(block));
    return `Newspaper issue #${issue.issue_number} "${issue.document.title}" (${issue.document.date}), issue_id ${issue.id}:\n${lines.join('\n')}\nUse read_newspaper_item with an item id for the full text and sources.`;
  },
};

export const readNewspaperItemTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_newspaper_item',
      description: 'Read one item of a newspaper issue: full text, title, direct url and sources. Pass the item id from newspaper_issue_contents or from a [NEWSPAPER CONTEXT] block. Without newspaper_id, uses the issue the reader currently has open. Do not call it when the full text is already visible in the context above.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Item id, e.g. the id inside [article …] / [note …] markers.' },
          newspaper_id: { type: 'number', description: 'Newspaper id from newspapers_list. Omit to use the currently open issue.' },
        },
        required: ['item_id'],
      },
    },
  },
  handler: async (args, context) => {
    const itemId = `${args.item_id || ''}`.trim();
    if (!itemId) return 'Error: item_id is required. Call newspaper_issue_contents to list valid ids.';
    const newspaperId = Number.isFinite(Number(args.newspaper_id)) && Number(args.newspaper_id) > 0 ? Number(args.newspaper_id) : null;
    const { issue, error } = resolveIssue(context.userId, newspaperId, context.chatId);
    if (error) return error;
    if (!issue) return 'Issue not found. Call newspapers_list for valid ids.';
    const material = findNewspaperMaterial(issue.document, itemId);
    if (!material) return `Item "${itemId}" not found in issue #${issue.issue_number}. Call newspaper_issue_contents to list valid ids.`;
    const lines = [
      `[${material.kind} ${itemId}] "${material.title}"`,
      material.text || '(no text)',
    ];
    if (material.url) lines.push('', `Source article: ${material.url}`);
    if (material.sources && material.sources.length > 0) {
      lines.push('', 'Sources:', ...material.sources.map(source => `- ${source.title} — ${source.url}`));
    }
    return lines.join('\n');
  },
};
