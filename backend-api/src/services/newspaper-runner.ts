import { getUserById } from './chats.js';
import { sendMessageThroughAi } from './ai.js';
import { DEFAULT_LANGUAGE, getLanguageDisplayName, normalizeSupportedLanguage } from '../i18n/languages.js';
import {
  createNewspaperAgentRun,
  createNewspaperIssue,
  finishNewspaperAgentRun,
  finishNewspaperRun,
  getNewspaper,
  getNewspaperRunInternal,
  markNewspaperRunStarted,
  setNewspaperRunDraft,
  setNewspaperRunPhase,
  validateNewspaperDocument,
} from './newspapers.js';
import { sendToDesktop } from '../ws-clients.js';

type ActiveRun = {
  controller: AbortController;
  agents: Map<number, AbortController>;
};

const activeRuns = new Map<number, ActiveRun>();

const editorSystemPrompt = `You are the autonomous editor of a personal newspaper.

You do not have direct web access. Your only tool is invoke_subagent. You may invoke only the fixed "news_researcher" agent. Delegate focused research tasks, preferably several independent topics, then assess the returned dossiers yourself.

User interests are positive editorial signals, not a checklist. User preferences are hard constraints. Do not include excluded topics. Prefer recent, consequential, verifiable information and primary sources. Reject weak, duplicated, promotional, stale, or unverified material.

The run request specifies the reader's selected language. Write all reader-facing newspaper prose in that language, including article and note titles and text, list items, captions, and weather descriptions. Source material may be in any language: translate and adapt it for the reader without changing facts, names, direct URLs, or the meaning of quotations.

After research, return exactly one valid JSON object and no markdown or commentary. It must follow this contract:
{
  "version": 1,
  "title": "string",
  "subtitle": "optional string",
  "date": "string",
  "blocks": [
    {
      "id": "unique string",
      "type": "article",
      "role": "hero | feature | standard",
      "title": "string",
      "text": "string",
      "url": "optional direct URL of the main material",
      "sources": [{ "title": "string", "url": "direct URL" }]
    },
    {
      "id": "unique string",
      "type": "note",
      "title": "optional string",
      "text": "optional string",
      "url": "optional direct URL"
    },
    {
      "id": "unique string",
      "type": "notes_list",
      "title": "optional string",
      "items": [{ "id": "optional string", "title": "optional string", "text": "optional string", "url": "optional direct URL" }]
    },
    {
      "id": "unique string",
      "type": "weather",
      "title": "optional string",
      "location": "string",
      "condition": "string",
      "details": "optional string",
      "periods": [{ "label": "string", "temperature": 0, "condition": "optional string" }]
    },
    {
      "id": "unique string",
      "type": "image",
      "title": "string",
      "image_url": "optional URL",
      "caption": "optional string",
      "prompt": "optional string"
    }
  ]
}

There are exactly five block types: article, note, notes_list, weather, image. "hero" is never a block type; it is an article role. Articles may keep multiple sources. Notes have only their own url and never sources.

For the current version do not create image blocks, because image research/generation is not connected yet. Do not invent weather; include weather only if the assigned context explicitly requests it and a researcher verifies it. Use article for developed stories, note for one compact item, and notes_list for related briefs. Include at most one hero article.`;

const emitRun = (runId: number) => {
  const run = getNewspaperRunInternal(runId);
  if (run) sendToDesktop(run.user_id, { type: 'newspaper_run_updated', run });
};

const localDate = (timezoneOffset: number) => {
  const shifted = new Date(Date.now() + timezoneOffset * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
};

const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim()
    || trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!candidate) throw new Error('newspaper_editor_returned_no_json');
  return JSON.parse(candidate);
};

export const startNewspaperRun = (runId: number): boolean => {
  const run = getNewspaperRunInternal(runId);
  if (!run || activeRuns.has(runId) || run.status !== 'queued') return false;
  const controller = new AbortController();
  const active: ActiveRun = { controller, agents: new Map() };
  activeRuns.set(runId, active);

  void (async () => {
    if (!markNewspaperRunStarted(runId)) return;
    emitRun(runId);
    const newspaper = getNewspaper(run.user_id, run.newspaper_id);
    const user = getUserById(run.user_id);
    if (!newspaper || !user) throw new Error('newspaper_or_user_not_found');
    const timezoneOffset = Number(user.timezone_offset) || 0;
    const language = normalizeSupportedLanguage(user.language) || DEFAULT_LANGUAGE;
    const languageName = getLanguageDisplayName(language);
    const date = localDate(timezoneOffset);
    let streamedDraft = '';
    let lastDraftWrite = 0;

    const result = await sendMessageThroughAi(
      run.user_id,
      [
        `Create a personal newspaper issue for local date ${date} (UTC${timezoneOffset >= 0 ? '+' : ''}${timezoneOffset}).`,
        `Newspaper name: ${newspaper.name}`,
        `Reader language: ${languageName} (${language}). Write the entire issue in this language even when the original sources use another language.`,
        `Reader interests:\n${newspaper.interests || 'No explicit interests; choose broadly important current stories.'}`,
        `Reader preferences and restrictions:\n${newspaper.preferences || 'No additional restrictions.'}`,
        'Research first. Then return the final issue JSON.',
      ].join('\n\n'),
      undefined,
      {
        forcePro: true,
        countAsUserMessage: false,
        skipHistory: true,
        isDesktop: true,
        isBackgroundTask: true,
        allowedTools: ['invoke_subagent'],
        systemPromptOverride: editorSystemPrompt,
        externalAbortSignal: controller.signal,
        featureFlags: { disable_adhoc_subagents: true },
        onToolStatus: async (text) => {
          setNewspaperRunPhase(runId, text || 'researching');
          emitRun(runId);
        },
        onStreamToken: async (text) => {
          streamedDraft += text;
          const now = Date.now();
          if (now - lastDraftWrite < 500) return;
          lastDraftWrite = now;
          setNewspaperRunPhase(runId, 'writing_issue');
          setNewspaperRunDraft(runId, streamedDraft);
          emitRun(runId);
        },
        onSubagentStart: async ({ agent, task }) => {
          if (agent !== 'news_researcher') throw new Error('newspaper_subagent_not_allowed');
          const agentRunId = createNewspaperAgentRun(runId, agent, task);
          const childController = new AbortController();
          const abortChild = () => childController.abort();
          controller.signal.addEventListener('abort', abortChild, { once: true });
          active.agents.set(agentRunId, childController);
          setNewspaperRunPhase(runId, 'researching');
          emitRun(runId);
          return { id: agentRunId, signal: childController.signal };
        },
        onSubagentFinish: async ({ id, trace, error }) => {
          if (!id) return;
          const child = active.agents.get(id);
          const cancelled = child?.signal.aborted || (trace as any)?.aborted;
          finishNewspaperAgentRun(id, {
            status: cancelled ? 'cancelled' : error ? 'failed' : 'ready',
            trace,
            error,
          });
          active.agents.delete(id);
          emitRun(runId);
        },
      },
    );

    if (controller.signal.aborted || result.aborted) {
      finishNewspaperRun(runId, {
        status: 'cancelled',
        phase: 'cancelled',
        draft: streamedDraft || null,
        editorTrace: { tool_calls: result.tool_calls, subagents: result.subagents, usage: result.usage },
      });
      emitRun(runId);
      return;
    }

    setNewspaperRunPhase(runId, 'validating');
    emitRun(runId);
    const rawDocument = extractJson(result.final_reply_text || result.reply_text);
    const document = validateNewspaperDocument({
      ...(rawDocument as Record<string, unknown>),
      date,
    });
    const issue = createNewspaperIssue(run.user_id, run.newspaper_id, document);
    finishNewspaperRun(runId, {
      status: 'ready',
      phase: 'ready',
      issueId: issue.id,
      draft: document,
      editorTrace: { tool_calls: result.tool_calls, subagents: result.subagents, usage: result.usage },
    });
    emitRun(runId);
  })().catch((error: any) => {
    const cancelled = controller.signal.aborted;
    finishNewspaperRun(runId, {
      status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? '' : (error?.message || String(error)),
    });
    emitRun(runId);
  }).finally(() => {
    activeRuns.delete(runId);
  });

  return true;
};

export const cancelNewspaperRun = (userId: number, runId: number): boolean => {
  const run = getNewspaperRunInternal(runId);
  if (!run || run.user_id !== userId || !['queued', 'running'].includes(run.status)) return false;
  const active = activeRuns.get(runId);
  if (active) {
    active.controller.abort();
  } else {
    finishNewspaperRun(runId, { status: 'cancelled', phase: 'cancelled' });
    emitRun(runId);
  }
  return true;
};

export const cancelNewspaperAgentRun = (userId: number, runId: number, agentRunId: number): boolean => {
  const run = getNewspaperRunInternal(runId);
  if (!run || run.user_id !== userId || run.status !== 'running') return false;
  const controller = activeRuns.get(runId)?.agents.get(agentRunId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
};

export const isNewspaperRunActive = (runId: number) => activeRuns.has(runId);
