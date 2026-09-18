import { db } from '../db.js';
import type {
  NewspaperAgentRunDto,
  NewspaperAgentRunStatus,
  NewspaperBlock,
  NewspaperDto,
  NewspaperIssueDocument,
  NewspaperIssueDto,
  NewspaperIssueStatus,
  NewspaperIssueSummaryDto,
  NewspaperRunDto,
  NewspaperRunStatus,
  NewspaperSource,
  NewspaperDeliveryFrequency,
  NewspaperStyle,
  NewspaperVolume,
  NewspaperWeatherMode,
} from '../types.js';
import { deleteMediaAssetIfUnreferenced, removeMediaReferencesForEntity } from './media-assets.js';

const STYLES = new Set<NewspaperStyle>(['wizarding', 'broadsheet', 'deusEx', 'massEffect']);
const ARTICLE_ROLES = new Set(['hero', 'feature', 'standard']);
const BLOCK_TYPES = new Set(['article', 'note', 'notes_list', 'weather', 'image']);
const MAX_TEXT = 20_000;

const cleanText = (value: unknown, max = MAX_TEXT) => `${value ?? ''}`.trim().slice(0, max);
const cleanStyle = (value: unknown): NewspaperStyle => STYLES.has(value as NewspaperStyle)
  ? value as NewspaperStyle
  : 'wizarding';
const cleanVolume = (value: unknown): NewspaperVolume =>
  value === 'compact' || value === 'extended' ? value : 'standard';
const cleanWeatherMode = (value: unknown): NewspaperWeatherMode =>
  value === 'today' || value === 'week' || value === 'auto' ? value : 'off';
const cleanDeliveryFrequency = (value: unknown): NewspaperDeliveryFrequency =>
  value === 'daily' || value === 'every_two_days' || value === 'weekly' ? value : 'manual';
const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown, max = MAX_TEXT): string | undefined => {
  const text = cleanText(value, max);
  return text || undefined;
};
const optionalUrl = (value: unknown): string | undefined => {
  const text = cleanText(value, 4_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
/** Shared source-list parsing for articles, notes, and notes_list items. */
const optionalSources = (value: unknown): NewspaperSource[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const sources = value.slice(0, 20).flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const sourceTitle = cleanText(item.title, 500);
    const url = optionalUrl(item.url);
    return sourceTitle && url ? [{ title: sourceTitle, url }] : [];
  });
  return sources.length ? sources : undefined;
};
const optionalImageUrl = (value: unknown): string | undefined => {
  const text = cleanText(value, 4_000);
  if (!text) return undefined;
  const localMatch = text.match(/^\/api\/v1\/images\/([^/?#]+)$/);
  if (localMatch) {
    try {
      const filename = decodeURIComponent(localMatch[1]);
      return filename && !filename.includes('/') && !filename.includes('\\') && filename !== '.' && filename !== '..'
        ? text
        : undefined;
    } catch {
      return undefined;
    }
  }
  return optionalUrl(text);
};
const parseJson = (raw: unknown): unknown => {
  if (raw == null || raw === '') return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
};

/**
 * Validates a single newspaper block and registers its id in `ids`.
 * Shared by the whole-document validator and the incremental add_blocks tool,
 * so tool payloads and stored documents obey the exact same rules.
 * Error codes carry the block index for actionable feedback.
 */
export const validateNewspaperBlock = (source: unknown, index: number, ids: Set<string>): NewspaperBlock => {
  if (!isRecord(source) || !BLOCK_TYPES.has(source.type)) throw new Error(`invalid_newspaper_block_${index}`);
  const id = cleanText(source.id, 120);
  if (!id || ids.has(id)) throw new Error(`invalid_newspaper_block_id_${index}`);
  ids.add(id);
  const titleValue = optionalText(source.title, 500);

  if (source.type === 'article') {
    const title = titleValue || '';
    const text = cleanText(source.text);
    if (!title || !text || !ARTICLE_ROLES.has(source.role)) throw new Error(`invalid_article_${index}`);
    const longText = optionalText(source.long_text);
    const sources = optionalSources(source.sources);
    return {
      id,
      type: 'article' as const,
      role: source.role as 'hero' | 'feature' | 'standard',
      title,
      text,
      ...(longText ? { long_text: longText } : {}),
      ...(optionalUrl(source.url) ? { url: optionalUrl(source.url) } : {}),
      ...(optionalImageUrl(source.image_url) ? { image_url: optionalImageUrl(source.image_url) } : {}),
      ...(sources ? { sources } : {}),
    };
  }

  if (source.type === 'note') {
    const text = optionalText(source.text);
    const longText = optionalText(source.long_text);
    const url = optionalUrl(source.url);
    const imageUrl = optionalImageUrl(source.image_url);
    const sources = optionalSources(source.sources);
    if (!titleValue && !text && !url && !imageUrl) throw new Error(`invalid_note_${index}`);
    return {
      id,
      type: 'note' as const,
      ...(titleValue ? { title: titleValue } : {}),
      ...(text ? { text } : {}),
      ...(longText ? { long_text: longText } : {}),
      ...(url ? { url } : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(sources ? { sources } : {}),
    };
  }

  if (source.type === 'notes_list') {
    if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 40) {
      throw new Error(`invalid_notes_list_${index}`);
    }
    const items = source.items.map((item: unknown, itemIndex: number) => {
      if (!isRecord(item)) throw new Error(`invalid_note_item_${index}_${itemIndex}`);
      const itemTitle = optionalText(item.title, 500);
      const text = optionalText(item.text);
      const longText = optionalText(item.long_text);
      const url = optionalUrl(item.url);
      const imageUrl = optionalImageUrl(item.image_url);
      const sources = optionalSources(item.sources);
      if (!itemTitle && !text && !url && !imageUrl) throw new Error(`invalid_note_item_${index}_${itemIndex}`);
      return {
        ...(optionalText(item.id, 120) ? { id: optionalText(item.id, 120) } : {}),
        ...(itemTitle ? { title: itemTitle } : {}),
        ...(text ? { text } : {}),
        ...(longText ? { long_text: longText } : {}),
        ...(url ? { url } : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(sources ? { sources } : {}),
      };
    });
    return { id, type: 'notes_list' as const, ...(titleValue ? { title: titleValue } : {}), items };
  }

  if (source.type === 'weather') {
    const location = cleanText(source.location, 240);
    const condition = cleanText(source.condition, 500);
    if (!location || !condition || !Array.isArray(source.periods) || source.periods.length === 0 || source.periods.length > 14) {
      throw new Error(`invalid_weather_${index}`);
    }
    const periods = source.periods.map((period: unknown, periodIndex: number) => {
      if (!isRecord(period)) throw new Error(`invalid_weather_period_${index}_${periodIndex}`);
      const label = cleanText(period.label, 120);
      const temperature = Number(period.temperature);
      if (!label || !Number.isFinite(temperature)) throw new Error(`invalid_weather_period_${index}_${periodIndex}`);
      return {
        label,
        temperature,
        ...(optionalText(period.condition, 240) ? { condition: optionalText(period.condition, 240) } : {}),
      };
    });
    return {
      id,
      type: 'weather' as const,
      ...(titleValue ? { title: titleValue } : {}),
      location,
      condition,
      ...(optionalText(source.details) ? { details: optionalText(source.details) } : {}),
      periods,
    };
  }

  const imageTitle = titleValue || '';
  if (!imageTitle) throw new Error(`invalid_image_${index}`);
  return {
    id,
    type: 'image' as const,
    title: imageTitle,
    ...(optionalImageUrl(source.image_url) ? { image_url: optionalImageUrl(source.image_url) } : {}),
    ...(optionalText(source.caption) ? { caption: optionalText(source.caption) } : {}),
    ...(optionalText(source.prompt, 2_000) ? { prompt: optionalText(source.prompt, 2_000) } : {}),
  };
};

export const validateNewspaperDocument = (raw: unknown): NewspaperIssueDocument => {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.blocks)) {
    throw new Error('invalid_newspaper_document');
  }
  const title = cleanText(raw.title, 240);
  const date = cleanText(raw.date, 120);
  if (!title || !date || raw.blocks.length === 0 || raw.blocks.length > 80) {
    throw new Error('invalid_newspaper_document');
  }

  const ids = new Set<string>();
  const blocks = raw.blocks.map((source: unknown, index: number) => validateNewspaperBlock(source, index, ids));

  return {
    version: 1,
    title,
    ...(optionalText(raw.subtitle, 500) ? { subtitle: optionalText(raw.subtitle, 500) } : {}),
    date,
    blocks,
  };
};

const parseDocument = (raw: string): NewspaperIssueDocument =>
  validateNewspaperDocument(JSON.parse(raw));

const mapIssueSummary = (row: any): NewspaperIssueSummaryDto => {
  let blocksCount = 0;
  try { blocksCount = parseDocument(String(row.document_json)).blocks.length; } catch {}
  return {
    id: Number(row.id),
    newspaper_id: Number(row.newspaper_id),
    issue_number: Number(row.issue_number),
    title: String(row.title || ''),
    subtitle: String(row.subtitle || ''),
    status: row.status as NewspaperIssueStatus,
    blocks_count: blocksCount,
    published_at: Number(row.published_at),
  };
};

const mapNewspaper = (row: any): NewspaperDto => ({
  id: Number(row.id),
  name: String(row.name || ''),
  editorial_brief: String(row.editorial_brief || ''),
  interests: String(row.interests || ''),
  preferences: String(row.preferences || ''),
  source_recommendations: String(row.source_recommendations || ''),
  issue_volume: cleanVolume(row.issue_volume),
  weather_mode: cleanWeatherMode(row.weather_mode),
  weather_location: String(row.weather_location || ''),
  delivery_frequency: cleanDeliveryFrequency(row.delivery_frequency),
  style: cleanStyle(row.style),
  enabled: Number(row.enabled) !== 0,
  issue_count: Number(row.issue_count || 0),
  latest_issue: row.latest_issue_id == null ? null : mapIssueSummary({
    id: row.latest_issue_id,
    newspaper_id: row.id,
    issue_number: row.latest_issue_number,
    title: row.latest_issue_title,
    subtitle: row.latest_issue_subtitle,
    status: row.latest_issue_status,
    document_json: row.latest_issue_document_json,
    published_at: row.latest_issue_published_at,
  }),
  created_at: Number(row.created_at),
  updated_at: Number(row.updated_at),
});

const mapAgentRun = (row: any): NewspaperAgentRunDto => ({
  id: Number(row.id),
  run_id: Number(row.run_id),
  agent_type: String(row.agent_type || ''),
  task: String(row.task || ''),
  status: row.status as NewspaperAgentRunStatus,
  tools_used: (parseJson(row.tools_used_json) as string[] | null) || [],
  result: parseJson(row.result_json),
  trace: parseJson(row.trace_json),
  error: String(row.error || ''),
  created_at: Number(row.created_at),
  started_at: Number(row.started_at),
  finished_at: row.finished_at == null ? null : Number(row.finished_at),
});

const mapRun = (row: any, agents: NewspaperAgentRunDto[]): NewspaperRunDto => ({
  id: Number(row.id),
  newspaper_id: Number(row.newspaper_id),
  user_id: Number(row.user_id),
  status: row.status as NewspaperRunStatus,
  phase: String(row.phase || ''),
  draft: parseJson(row.draft_json),
  editor_trace: parseJson(row.editor_trace_json),
  issue_id: row.issue_id == null ? null : Number(row.issue_id),
  error: String(row.error || ''),
  agents,
  created_at: Number(row.created_at),
  started_at: row.started_at == null ? null : Number(row.started_at),
  finished_at: row.finished_at == null ? null : Number(row.finished_at),
});

export const listNewspapers = (userId: number): NewspaperDto[] => {
  const rows = db.prepare(`
    SELECT n.*,
      (SELECT COUNT(*) FROM newspaper_issues ni WHERE ni.newspaper_id = n.id) AS issue_count,
      latest.id AS latest_issue_id,
      latest.issue_number AS latest_issue_number,
      latest.title AS latest_issue_title,
      latest.subtitle AS latest_issue_subtitle,
      latest.status AS latest_issue_status,
      latest.document_json AS latest_issue_document_json,
      latest.published_at AS latest_issue_published_at
    FROM newspapers n
    LEFT JOIN newspaper_issues latest ON latest.id = (
      SELECT ni.id FROM newspaper_issues ni
      WHERE ni.newspaper_id = n.id
      ORDER BY ni.issue_number DESC LIMIT 1
    )
    WHERE n.user_id = ?
    ORDER BY n.updated_at DESC, n.id DESC
  `).all(userId) as any[];
  return rows.map(mapNewspaper);
};

export const getNewspaper = (userId: number, newspaperId: number): NewspaperDto | null =>
  listNewspapers(userId).find(item => item.id === newspaperId) || null;

export const createNewspaper = (userId: number, input: {
  name?: unknown;
  editorial_brief?: unknown;
  interests?: unknown;
  preferences?: unknown;
  source_recommendations?: unknown;
  issue_volume?: unknown;
  weather_mode?: unknown;
  weather_location?: unknown;
  delivery_frequency?: unknown;
  style?: unknown;
}) => {
  const name = cleanText(input.name, 120);
  if (!name) return { ok: false as const, error: 'name_required' };
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO newspapers (
      user_id, name, editorial_brief, interests, preferences, source_recommendations,
      issue_volume, weather_mode, weather_location, delivery_frequency, style, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    name,
    cleanText(input.editorial_brief),
    cleanText(input.interests),
    cleanText(input.preferences),
    cleanText(input.source_recommendations),
    cleanVolume(input.issue_volume),
    cleanWeatherMode(input.weather_mode),
    cleanText(input.weather_location, 240),
    cleanDeliveryFrequency(input.delivery_frequency),
    cleanStyle(input.style),
    now,
    now,
  );
  return { ok: true as const, id: Number(result.lastInsertRowid) };
};

export const ensureDefaultNewspaper = (userId: number): NewspaperDto => {
  const existing = listNewspapers(userId)[0];
  if (existing) return existing;
  const created = createNewspaper(userId, { name: 'Chatter Daily', style: 'wizarding' });
  if (!created.ok) throw new Error(created.error);
  return getNewspaper(userId, created.id)!;
};

export const updateNewspaper = (userId: number, newspaperId: number, input: Record<string, unknown>) => {
  const existing = db.prepare('SELECT * FROM newspapers WHERE id = ? AND user_id = ?').get(newspaperId, userId) as any;
  if (!existing) return { ok: false as const, error: 'newspaper_not_found' };
  const name = input.name === undefined ? String(existing.name) : cleanText(input.name, 120);
  if (!name) return { ok: false as const, error: 'name_required' };
  db.prepare(`
    UPDATE newspapers SET
      name = ?, editorial_brief = ?, interests = ?, preferences = ?, source_recommendations = ?,
      issue_volume = ?, weather_mode = ?, weather_location = ?, delivery_frequency = ?,
      style = ?, enabled = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    name,
    input.editorial_brief === undefined ? existing.editorial_brief : cleanText(input.editorial_brief),
    input.interests === undefined ? existing.interests : cleanText(input.interests),
    input.preferences === undefined ? existing.preferences : cleanText(input.preferences),
    input.source_recommendations === undefined ? existing.source_recommendations : cleanText(input.source_recommendations),
    input.issue_volume === undefined ? cleanVolume(existing.issue_volume) : cleanVolume(input.issue_volume),
    input.weather_mode === undefined ? cleanWeatherMode(existing.weather_mode) : cleanWeatherMode(input.weather_mode),
    input.weather_location === undefined ? existing.weather_location : cleanText(input.weather_location, 240),
    input.delivery_frequency === undefined ? cleanDeliveryFrequency(existing.delivery_frequency) : cleanDeliveryFrequency(input.delivery_frequency),
    input.style === undefined ? cleanStyle(existing.style) : cleanStyle(input.style),
    input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0),
    Math.floor(Date.now() / 1000),
    newspaperId,
    userId,
  );
  return { ok: true as const };
};

export const listNewspaperIssues = (userId: number, newspaperId: number, limit = 30): NewspaperIssueSummaryDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
  return (db.prepare(`
    SELECT * FROM newspaper_issues
    WHERE user_id = ? AND newspaper_id = ?
    ORDER BY issue_number DESC LIMIT ?
  `).all(userId, newspaperId, safeLimit) as any[]).map(mapIssueSummary);
};

export const getNewspaperIssue = (userId: number, issueId: number): NewspaperIssueDto | null => {
  const row = db.prepare('SELECT * FROM newspaper_issues WHERE id = ? AND user_id = ?').get(issueId, userId) as any;
  if (!row) return null;
  try { return { ...mapIssueSummary(row), document: parseDocument(String(row.document_json)) }; } catch { return null; }
};

export const createNewspaperIssue = (userId: number, newspaperId: number, rawDocument: unknown): NewspaperIssueDto =>
  db.transaction(() => {
    if (!getNewspaper(userId, newspaperId)) throw new Error('newspaper_not_found');
    const document = validateNewspaperDocument(rawDocument);
    const current = db.prepare('SELECT COALESCE(MAX(issue_number), 0) AS n FROM newspaper_issues WHERE newspaper_id = ?')
      .get(newspaperId) as { n: number };
    const issueNumber = Number(current.n) + 1;
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(`
      INSERT INTO newspaper_issues (newspaper_id, user_id, issue_number, title, subtitle, status, document_json, published_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
    `).run(newspaperId, userId, issueNumber, document.title, document.subtitle || '', JSON.stringify(document), now, now);
    db.prepare('UPDATE newspapers SET updated_at = ? WHERE id = ?').run(now, newspaperId);
    const issue = getNewspaperIssue(userId, Number(result.lastInsertRowid));
    if (!issue) throw new Error('newspaper_issue_create_failed');
    return issue;
  })();

export const deleteNewspaperIssue = (userId: number, issueId: number) => {
  const exists = db.prepare('SELECT 1 FROM newspaper_issues WHERE id = ? AND user_id = ?')
    .get(issueId, userId);
  if (!exists) return false;
  const assetIds = removeMediaReferencesForEntity('newspaper_issue', issueId);
  db.prepare('DELETE FROM newspaper_issues WHERE id = ? AND user_id = ?').run(issueId, userId);
  for (const assetId of assetIds) deleteMediaAssetIfUnreferenced(assetId);
  return true;
};

export const createNewspaperRun = (userId: number, newspaperId: number) => {
  if (!getNewspaper(userId, newspaperId)) return { ok: false as const, error: 'newspaper_not_found' };
  const active = db.prepare(`
    SELECT id FROM newspaper_runs
    WHERE user_id = ? AND newspaper_id = ? AND status IN ('queued', 'running')
    ORDER BY id DESC LIMIT 1
  `).get(userId, newspaperId) as { id: number } | undefined;
  if (active) return { ok: false as const, error: 'newspaper_run_active', run: getNewspaperRun(userId, active.id) };
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO newspaper_runs (newspaper_id, user_id, status, phase, created_at)
    VALUES (?, ?, 'queued', 'queued', ?)
  `).run(newspaperId, userId, now);
  return { ok: true as const, run: getNewspaperRun(userId, Number(result.lastInsertRowid))! };
};

export const getNewspaperRun = (userId: number, runId: number): NewspaperRunDto | null => {
  const row = db.prepare('SELECT * FROM newspaper_runs WHERE id = ? AND user_id = ?').get(runId, userId) as any;
  if (!row) return null;
  const agents = (db.prepare('SELECT * FROM newspaper_run_agents WHERE run_id = ? ORDER BY id ASC').all(runId) as any[]).map(mapAgentRun);
  return mapRun(row, agents);
};

export const getNewspaperRunInternal = (runId: number): NewspaperRunDto | null => {
  const row = db.prepare('SELECT * FROM newspaper_runs WHERE id = ?').get(runId) as any;
  return row ? getNewspaperRun(Number(row.user_id), runId) : null;
};

export const listNewspaperRuns = (userId: number, newspaperId: number, limit = 10): NewspaperRunDto[] => {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || 10)));
  const rows = db.prepare(`
    SELECT id FROM newspaper_runs WHERE user_id = ? AND newspaper_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(userId, newspaperId, safeLimit) as Array<{ id: number }>;
  return rows.flatMap(row => {
    const run = getNewspaperRun(userId, Number(row.id));
    return run ? [run] : [];
  });
};

export const markNewspaperRunStarted = (runId: number) => db.prepare(`
  UPDATE newspaper_runs SET status = 'running', phase = 'planning', started_at = ?
  WHERE id = ? AND status = 'queued'
`).run(Math.floor(Date.now() / 1000), runId).changes > 0;

export const setNewspaperRunPhase = (runId: number, phase: string) => db
  .prepare("UPDATE newspaper_runs SET phase = ? WHERE id = ? AND status = 'running'")
  .run(cleanText(phase, 240), runId);

export const setNewspaperRunDraft = (runId: number, draft: unknown) => db
  .prepare("UPDATE newspaper_runs SET draft_json = ? WHERE id = ? AND status = 'running'")
  .run(JSON.stringify(draft), runId);

export const finishNewspaperRun = (runId: number, input: {
  status: Exclude<NewspaperRunStatus, 'queued' | 'running'>;
  phase: string;
  issueId?: number | null;
  draft?: unknown;
  editorTrace?: unknown;
  error?: string;
}) => db.prepare(`
  UPDATE newspaper_runs
  SET status = ?, phase = ?, issue_id = ?, draft_json = ?, editor_trace_json = ?, error = ?, finished_at = ?
  WHERE id = ?
`).run(
  input.status,
  cleanText(input.phase, 240),
  input.issueId ?? null,
  input.draft === undefined ? null : JSON.stringify(input.draft),
  input.editorTrace === undefined ? null : JSON.stringify(input.editorTrace),
  cleanText(input.error),
  Math.floor(Date.now() / 1000),
  runId,
);

export const createNewspaperAgentRun = (runId: number, agentType: string, task: string): number => {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO newspaper_run_agents (run_id, agent_type, task, status, created_at, started_at)
    VALUES (?, ?, ?, 'running', ?, ?)
  `).run(runId, cleanText(agentType, 120), cleanText(task), now, now);
  return Number(result.lastInsertRowid);
};

export const finishNewspaperAgentRun = (agentRunId: number, input: {
  status: NewspaperAgentRunStatus;
  trace?: any;
  error?: string;
}) => {
  const toolsUsed = Array.isArray(input.trace?.tools_used) ? input.trace.tools_used : [];
  db.prepare(`
    UPDATE newspaper_run_agents
    SET status = ?, tools_used_json = ?, result_json = ?, trace_json = ?, error = ?, finished_at = ?
    WHERE id = ?
  `).run(
    input.status,
    JSON.stringify(toolsUsed),
    input.trace?.answer === undefined ? null : JSON.stringify(input.trace.answer),
    input.trace === undefined ? null : JSON.stringify(input.trace),
    cleanText(input.error),
    Math.floor(Date.now() / 1000),
    agentRunId,
  );
};

export const markInterruptedNewspaperRuns = () => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE newspaper_runs SET status = 'failed', phase = 'interrupted', error = 'server_restarted', finished_at = ?
    WHERE status IN ('queued', 'running')
  `).run(now);
  db.prepare(`
    UPDATE newspaper_run_agents SET status = 'failed', error = 'server_restarted', finished_at = ?
    WHERE status = 'running'
  `).run(now);
};

const demoDocument = (issueNumber: number): NewspaperIssueDocument => ({
  version: 1,
  title: 'Chatter Daily',
  subtitle: `Утренний выпуск · №${issueNumber}`,
  date: new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' }).format(new Date()),
  blocks: [
    { id: 'hero-ai', type: 'article', role: 'hero', title: 'Агенты становятся частью обычных приложений', text: 'Главная тема выпуска — как специализированные агенты превращают сложные процессы в понятные пользовательские функции.', url: 'https://openai.com/research/', sources: [{ title: 'OpenAI Research', url: 'https://openai.com/research/' }] },
    { id: 'brief', type: 'notes_list', title: 'Коротко', items: [
      { id: 'react', title: 'React продолжает улучшать серверный рендеринг', text: 'Экосистема постепенно стандартизирует новые подходы.', url: 'https://react.dev/blog' },
      { id: 'space', title: 'Новый взгляд на космические телескопы', text: 'Инженеры тестируют инструменты следующего поколения.', url: 'https://www.nasa.gov/' },
    ] },
    { id: 'weather', type: 'weather', title: 'Погода на день', location: 'Томск', condition: 'Переменная облачность', details: 'Без сильного ветра и осадков.', periods: [
      { label: 'Утро', temperature: 9, condition: 'Облачно' },
      { label: 'День', temperature: 14, condition: 'Без дождя' },
      { label: 'Вечер', temperature: 10, condition: 'Прохладно' },
    ] },
    { id: 'cat', type: 'image', title: 'Кот дня', caption: 'Редакция напоминает: иногда производительность повышается после десяти минут ничегонеделания.', prompt: 'sleepy newsroom cat' },
    { id: 'humor', type: 'note', title: 'На последней полосе', text: 'Планёрка закончилась успешно: все задачи перенесли на следующую планёрку.' },
  ],
});

export const createDemoNewspaperIssue = (userId: number): NewspaperIssueDto => {
  const newspaper = ensureDefaultNewspaper(userId);
  return createNewspaperIssue(userId, newspaper.id, demoDocument(newspaper.issue_count + 1));
};
