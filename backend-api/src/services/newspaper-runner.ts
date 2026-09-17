import { getUserById } from './chats.js';
import { createInvokeSubagentTool, runAgent } from './agent-runner.js';
import { materializeAssetInput } from './response-attachments.js';
import { attachMediaAsset } from './media-assets.js';
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

User interests are positive editorial signals, not a checklist. User preferences are hard constraints. Do not include excluded topics. Prefer consequential, verifiable information and primary sources. Reject weak, duplicated, promotional, misleading, or unverified material.

Create a complete personal newspaper, not merely a list of breaking-news summaries. Build the issue from three editorial layers:
1. Current events: important and relevant developments from the current news period.
2. Depth and context: explanations, analysis, background, and retrospectives related to the reader's interests. These may use older material when it provides useful context or has a clear reason to be included now.
3. Discovery and enjoyment: evergreen stories, culture, science, technology, games, recommendations, unusual discoveries, and other enjoyable material selected for this reader. These may come from any time period.

Freshness restrictions apply strictly only to content presented as current news. Never present an older article or event as new. Frame older material honestly as context, analysis, a retrospective, a recommendation, or an interesting discovery. The reader's explicit interests, preferences, and restrictions override the default balance between these layers.

Research a broader candidate pool before applying the requested edition size. Editorial selection must happen after the available material has been evaluated; do not ask researchers for only the exact number of stories expected in the final issue.

Images are optional editorial elements, not a quota. Ask researchers to bring back suitable image candidates when a story would benefit from illustration. Researchers may also include strong images they encounter naturally. If the factual research is already complete but an important story still needs an image, invoke a researcher with a focused image-finding task and provide the known story context and source URLs; do not ask it to repeat the full topic research.

Use only exact image URLs actually returned and, when appropriate, visually checked by researchers. Never invent, reconstruct, or guess an image URL. Prefer meaningful images for hero and feature stories, then use them selectively elsewhere. Avoid repetitive decoration, irrelevant stock imagery, avatars, logos, advertisements, interface graphics, and poor thumbnails unless they are themselves the subject. A normal issue should remain a newspaper rather than becoming an accidental gallery. However, when the reader's interests or the issue concept are inherently visual—for example photography, art, design, travel imagery, or a requested collection of cat pictures—an image-rich issue or deliberate gallery-like sequence is appropriate. Let editorial relevance determine visual density rather than a fixed count.

Use an image block only when the image itself is editorial content and an actual image_url is available. If no trustworthy and relevant image was found, omit image_url instead of substituting a weak or invented image.

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
      "image_url": "optional exact image URL",
      "sources": [{ "title": "string", "url": "direct URL" }]
    },
    {
      "id": "unique string",
      "type": "note",
      "title": "optional string",
      "text": "optional string",
      "url": "optional direct URL",
      "image_url": "optional exact image URL"
    },
    {
      "id": "unique string",
      "type": "notes_list",
      "title": "optional string",
      "items": [{ "id": "optional string", "title": "optional string", "text": "optional string", "url": "optional direct URL", "image_url": "optional exact image URL" }]
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

Do not invent weather; include weather only if the assigned context explicitly requests it and a researcher verifies it. Use article for developed stories, note for one compact item, and notes_list for related briefs. Include at most one hero article.`;

const emitRun = (runId: number) => {
  const run = getNewspaperRunInternal(runId);
  if (run) sendToDesktop(run.user_id, { type: 'newspaper_run_updated', run });
};

const localDate = (timezoneOffset: number) => {
  const shifted = new Date(Date.now() + timezoneOffset * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
};

const volumeInstruction = (volume: 'compact' | 'standard' | 'extended') => {
  const sharedRules = `Count distinct stories across articles, individual notes, and notes_list items. All numerical ranges are soft editorial guidance, not quotas or hard limits. Never add weak, repetitive, or irrelevant material merely to reach a minimum. Never exclude an important, trustworthy, and highly relevant story merely to remain below a maximum. Never reduce a story that deserves a full article into a note solely to satisfy the suggested article count. If the available material is unusually strong, the issue may exceed the typical range. If there is not enough strong material, publish a smaller issue instead of filling it with noise.`;
  if (volume === 'compact') {
    return `Selected edition size: COMPACT. Produce a concise but complete issue, typically containing 6-10 distinct stories. Usually develop 1-3 of the strongest stories as full articles and present the remaining material as individual notes or thematic notes_list blocks. Apply a high editorial threshold: include only the most important or especially reader-relevant material. ${sharedRules}`;
  }
  if (volume === 'extended') {
    return `Selected edition size: EXTENDED. Produce a broad issue, typically containing 20-35 distinct stories. Usually develop 7-12 stories as full articles. Cover both major and more niche topics relevant to the reader. Organize shorter material into several thematic notes_list blocks instead of one miscellaneous collection. ${sharedRules}`;
  }
  return `Selected edition size: STANDARD. Produce a substantial issue, typically containing 12-20 distinct stories. Usually develop 4-7 stories as full articles. Use several thematic notes_list blocks where appropriate and balance current events, deeper reading, and enjoyable discoveries. ${sharedRules}`;
};

const resolveWeatherMode = (newspaper: ReturnType<typeof getNewspaper>) => {
  if (!newspaper || newspaper.weather_mode !== 'auto') return newspaper?.weather_mode || 'off';
  if (newspaper.delivery_frequency === 'weekly') return 'week';
  if (newspaper.delivery_frequency === 'daily' || newspaper.delivery_frequency === 'every_two_days') return 'today';
  return 'off';
};

const weatherInstruction = (newspaper: NonNullable<ReturnType<typeof getNewspaper>>) => {
  const mode = resolveWeatherMode(newspaper);
  const location = newspaper.weather_location.trim();
  if (mode === 'off' || !location) return '';
  if (mode === 'week') {
    return `Weather request: include one verified weather block for ${location} covering the next seven calendar days. Use exactly seven periods, one per day, with clear day/date labels. Delegate weather verification to the researcher; do not invent a forecast.`;
  }
  return `Weather request: include one verified weather block for ${location} covering the current local day. Prefer Morning, Day, and Evening periods. Delegate weather verification to the researcher; do not invent a forecast.`;
};

const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim()
    || trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!candidate) throw new Error('newspaper_editor_returned_no_json');
  return JSON.parse(candidate);
};

const materializeNewspaperImages = async (
  userId: number,
  document: ReturnType<typeof validateNewspaperDocument>,
) => {
  const assetIds = new Set<number>();
  const resolved = new Map<string, string | null>();
  const normalizeImageUrl = async (url: string | undefined): Promise<string | undefined> => {
    if (!url) return undefined;
    if (resolved.has(url)) return resolved.get(url) || undefined;
    try {
      const materialized = await materializeAssetInput(userId, { url, retention: 'temporary' });
      if (materialized.kind !== 'image' || !materialized.mediaAsset) throw new Error('not_an_image');
      assetIds.add(materialized.mediaAsset.id);
      resolved.set(url, materialized.localUrl);
      return materialized.localUrl;
    } catch (error: any) {
      console.warn('[newspaper] image materialization failed:', url, error?.message || error);
      resolved.set(url, null);
      return undefined;
    }
  };

  for (const block of document.blocks) {
    if ('image_url' in block) {
      const normalized = await normalizeImageUrl(block.image_url);
      if (normalized) block.image_url = normalized;
      else delete block.image_url;
    }
    if (block.type === 'notes_list') {
      for (const item of block.items) {
        const normalized = await normalizeImageUrl(item.image_url);
        if (normalized) item.image_url = normalized;
        else delete item.image_url;
      }
    }
  }
  return { document, assetIds };
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

    const invokeSubagent = createInvokeSubagentTool({
      allowedSubagents: ['news_researcher'],
      lifecycle: {
        onStart: async ({ agent, task }) => {
          const agentRunId = createNewspaperAgentRun(runId, agent, task);
          const childController = new AbortController();
          const abortChild = () => childController.abort();
          controller.signal.addEventListener('abort', abortChild, { once: true });
          active.agents.set(agentRunId, childController);
          setNewspaperRunPhase(runId, 'researching');
          emitRun(runId);
          return { id: agentRunId, signal: childController.signal };
        },
        onFinish: async ({ id, trace, error }) => {
          if (!id) return;
          const child = active.agents.get(id);
          const cancelled = child?.signal.aborted || trace?.aborted;
          finishNewspaperAgentRun(id, {
            status: cancelled ? 'cancelled' : error ? 'failed' : 'ready',
            trace,
            error,
          });
          active.agents.delete(id);
          emitRun(runId);
        },
      },
    });
    const editorInput = [
      `Create a personal newspaper issue for local date ${date} (UTC${timezoneOffset >= 0 ? '+' : ''}${timezoneOffset}).`,
      `Newspaper name: ${newspaper.name}`,
      `Reader language: ${languageName} (${language}). Write the entire issue in this language even when the original sources use another language.`,
      `Reader interests:\n${newspaper.interests || 'No explicit interests; choose broadly important current stories.'}`,
      `Reader preferences and restrictions:\n${newspaper.preferences || 'No additional restrictions.'}`,
      volumeInstruction(newspaper.issue_volume),
    ];
    if (newspaper.source_recommendations.trim()) {
      editorInput.push(
        `Reader-recommended research sources (soft guidance, not an allowlist):\n${newspaper.source_recommendations.trim()}\nAsk researchers to check these sources where relevant, but verify their claims and use other reliable sources whenever useful.`,
      );
    }
    const requestedWeather = weatherInstruction(newspaper);
    if (requestedWeather) editorInput.push(requestedWeather);
    editorInput.push('Research first. Then return the final issue JSON.');

    const result = await runAgent({
      userId: run.user_id,
      name: 'newspaper_editor',
      systemPrompt: editorSystemPrompt,
      input: editorInput.join('\n\n'),
      tools: [invokeSubagent],
      maxLoops: 2000,
      maxTokens: 16_384,
      timezoneOffset,
      signal: controller.signal,
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
    });

    if (controller.signal.aborted || result.aborted) {
      finishNewspaperRun(runId, {
        status: 'cancelled',
        phase: 'cancelled',
        draft: streamedDraft || null,
        editorTrace: { tool_calls: result.toolCalls, iterations: result.iterations, usage: result.usage },
      });
      emitRun(runId);
      return;
    }

    setNewspaperRunPhase(runId, 'validating');
    emitRun(runId);
    const rawDocument = extractJson(result.finalText);
    const validatedDocument = validateNewspaperDocument({
      ...(rawDocument as Record<string, unknown>),
      date,
    });
    const { document, assetIds } = await materializeNewspaperImages(run.user_id, validatedDocument);
    const issue = createNewspaperIssue(run.user_id, run.newspaper_id, document);
    for (const assetId of assetIds) {
      attachMediaAsset({
        assetId,
        entityType: 'newspaper_issue',
        entityId: issue.id,
        slot: 'image',
      });
    }
    finishNewspaperRun(runId, {
      status: 'ready',
      phase: 'ready',
      issueId: issue.id,
      draft: document,
      editorTrace: { tool_calls: result.toolCalls, iterations: result.iterations, usage: result.usage },
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
