import { stripIntuitionHint } from './intuition-prompt.js';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { getDecisionSettings } from './decision-settings.js';
import { runDecision } from './decision-runner.js';

export type IntuitionQuestion = { id: string; name: string; question: string; enabled: boolean };
export type IntuitionSettings = {
  mode: 'inherit' | 'enabled' | 'disabled';
  historyMessages: number | null;
  questions: IntuitionQuestion[] | null;
};
export type IntuitionSnapshot = {
  status: 'ready' | 'unavailable';
  createdAt: number;
  fingerprint: string;
  model: string;
  historyMessages: number;
  elapsedMs?: number;
  signals: Array<IntuitionQuestion & { probability: number }>;
};
export const defaultIntuitionQuestions: IntuitionQuestion[] = [
  {
    id: 'frustration',
    name: 'User frustration',
    question: "Is the user frustrated with the assistant's previous response?",
    enabled: true,
  },
  { id: 'humor', name: 'Humor', question: 'Is the user joking or being humorous?', enabled: true },
  {
    id: 'discussion',
    name: 'Discussion intent',
    question: 'Does the user want to continue the discussion rather than receive a solution?',
    enabled: true,
  },
  {
    id: 'implicit_meaning',
    name: 'Implicit meaning',
    question: 'Is the user implying something important without stating it explicitly?',
    enabled: true,
  },
  {
    id: 'advice',
    name: 'Unsolicited advice inappropriateness',
    question: 'Would offering help or advice be inappropriate at this moment?',
    enabled: true,
  },
];
export function normalizeIntuitionSettings(raw: any, chat: boolean): IntuitionSettings {
  if (
    !raw ||
    !['inherit', 'enabled', 'disabled'].includes(raw.mode) ||
    (!chat && raw.mode === 'inherit') ||
    (raw.historyMessages !== null &&
      (!Number.isInteger(raw.historyMessages) ||
        raw.historyMessages < 0 ||
        raw.historyMessages > 50)) ||
    (raw.questions !== null && !Array.isArray(raw.questions))
  )
    throw new Error('intuition_invalid_settings');
  let questions = raw.questions;
  if (questions !== null) {
    if (questions.length > 20 || new Set(questions.map((q) => q?.id)).size !== questions.length)
      throw new Error('intuition_invalid_settings');
    questions = questions.map((q: any) => {
      if (
        !q ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(q.id) ||
        typeof q.name !== 'string' ||
        !q.name.trim() ||
        q.name.length > 100 ||
        typeof q.question !== 'string' ||
        !q.question.trim() ||
        q.question.length > 1000 ||
        typeof q.enabled !== 'boolean'
      )
        throw new Error('intuition_invalid_settings');
      return { id: q.id, name: q.name.trim(), question: q.question.trim(), enabled: q.enabled };
    });
  }
  return { mode: raw.mode, historyMessages: raw.historyMessages, questions };
}
function row(userId: number, chatId: number | null) {
  return db
    .prepare(
      'SELECT settings_json, revision FROM intuition_settings WHERE user_id = ? AND chat_id IS ?',
    )
    .get(userId, chatId) as { settings_json: string; revision: number } | undefined;
}
export function getIntuitionSettings(userId: number, chatId: number | null) {
  const language = (
    db.prepare('SELECT language FROM users WHERE id = ?').get(userId) as
      { language?: string } | undefined
  )?.language;
  const russianNames = [
    'Раздражение',
    'Юмор',
    'Желание обсудить',
    'Неявный подтекст',
    'Неуместность советов',
  ];
  const defaults = defaultIntuitionQuestions.map((question, index) => ({
    ...question,
    name: language?.startsWith('ru') ? russianNames[index] : question.name,
  }));
  const globalRow = row(userId, null);
  const global: IntuitionSettings = globalRow
    ? JSON.parse(globalRow.settings_json)
    : { mode: 'disabled', historyMessages: 10, questions: null };
  const saved = chatId === null ? globalRow : row(userId, chatId);
  const settings: IntuitionSettings = saved
    ? JSON.parse(saved.settings_json)
    : chatId === null
      ? global
      : { mode: 'inherit', historyMessages: null, questions: null };
  return {
    settings,
    revision: saved?.revision ?? 0,
    defaults,
    available: getDecisionSettings().enabled && getDecisionSettings().apiKeyId !== null,
    inherited: {
      historyMessages: global.historyMessages ?? 10,
      questions: global.questions ?? defaults,
    },
    effective: {
      enabled: (settings.mode === 'inherit' ? global.mode : settings.mode) === 'enabled',
      historyMessages: settings.historyMessages ?? global.historyMessages ?? 10,
      questions: settings.questions ?? global.questions ?? defaults,
    },
  };
}
export function saveIntuitionSettings(
  userId: number,
  chatId: number | null,
  raw: any,
  revision: number,
) {
  const settings = normalizeIntuitionSettings(raw, chatId !== null);
  return db.transaction(() => {
    const saved = row(userId, chatId);
    if (!Number.isSafeInteger(revision) || revision !== (saved?.revision ?? 0))
      throw new Error('intuition_settings_changed');
    if (saved)
      db.prepare(
        'UPDATE intuition_settings SET settings_json = ?, revision = revision + 1 WHERE user_id = ? AND chat_id IS ?',
      ).run(JSON.stringify(settings), userId, chatId);
    else
      db.prepare(
        'INSERT INTO intuition_settings (user_id, chat_id, settings_json, revision) VALUES (?, ?, ?, 1)',
      ).run(userId, chatId, JSON.stringify(settings));
    return getIntuitionSettings(userId, chatId);
  })();
}
function messageText(message: any): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content))
    return message.content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  return '';
}
export async function evaluateIntuition(params: {
  userId: number;
  chatId: number;
  history: any[];
  currentMessage: any;
  signal?: AbortSignal;
  previous?: IntuitionSnapshot | null;
  billingUserId?: number;
}): Promise<IntuitionSnapshot | null> {
  const config = getIntuitionSettings(params.userId, params.chatId);
  const questions = config.effective.questions.filter((q) => q.enabled);
  if (!config.effective.enabled || !questions.length) return null;
  const history =
    config.effective.historyMessages === 0
      ? []
      : params.history
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-config.effective.historyMessages)
          .map((m) => ({ role: m.role, content: stripIntuitionHint(messageText(m)).slice(-8000) }));
  while (JSON.stringify(history).length > 80000) history.shift();
  const input = {
    conversation_history: history,
    current_user_message: stripIntuitionHint(messageText({ content: params.currentMessage })).slice(
      -16000,
    ),
  };
  const integration = getDecisionSettings();
  const model = integration.model;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ input, questions, model, baseUrl: integration.baseUrl }))
    .digest('hex');
  if (
    config.available &&
    params.previous?.status === 'ready' &&
    params.previous.fingerprint === fingerprint
  )
    return params.previous;
  const base = { fingerprint, createdAt: Date.now(), model, historyMessages: history.length };
  try {
    const result = await runDecision({
      userId: params.billingUserId ?? params.userId,
      purpose: 'intuition',
      input,
      questions: questions.map((q) => ({ id: q.id, question: q.question })),
      signal: params.signal,
    });
    return {
      ...base,
      status: 'ready',
      elapsedMs: result.elapsedMs,
      signals: questions.map((q) => ({
        ...q,
        probability: result.answers.find((a) => a.id === q.id)!.probability,
      })),
    };
  } catch {
    params.signal?.throwIfAborted();
    return { ...base, status: 'unavailable', signals: [] };
  }
}
export function newIntuitionQuestionId() {
  return 'signal_' + randomUUID().replace(/-/g, '');
}
