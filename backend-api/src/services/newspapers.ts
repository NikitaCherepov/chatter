import { db } from '../db.js';
import type {
  NewspaperDto,
  NewspaperIssueDocument,
  NewspaperIssueDto,
  NewspaperIssueStatus,
  NewspaperIssueSummaryDto,
  NewspaperStyle,
} from '../types.js';

const STYLES = new Set<NewspaperStyle>(['classic', 'modern', 'magical']);
const MAX_TEXT = 20_000;

const cleanText = (value: unknown, max = MAX_TEXT) => `${value ?? ''}`.trim().slice(0, max);
const cleanStyle = (value: unknown): NewspaperStyle => STYLES.has(value as NewspaperStyle)
  ? value as NewspaperStyle
  : 'classic';

const parseDocument = (raw: string): NewspaperIssueDocument => {
  const value = JSON.parse(raw) as NewspaperIssueDocument;
  if (!value || value.version !== 1 || !Array.isArray(value.blocks) || typeof value.title !== 'string') {
    throw new Error('invalid_newspaper_document');
  }
  return value;
};

const mapIssueSummary = (row: any): NewspaperIssueSummaryDto => {
  let blocksCount = 0;
  try { blocksCount = parseDocument(String(row.document_json)).blocks.length; } catch { /* Corrupt issues stay visible. */ }
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

export const createNewspaper = (userId: number, input: {
  name?: unknown;
  editorial_brief?: unknown;
  interests?: unknown;
  preferences?: unknown;
  style?: unknown;
}) => {
  const name = cleanText(input.name, 120);
  if (!name) return { ok: false as const, error: 'name_required' };
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO newspapers (user_id, name, editorial_brief, interests, preferences, style, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    name,
    cleanText(input.editorial_brief),
    cleanText(input.interests),
    cleanText(input.preferences),
    cleanStyle(input.style),
    now,
    now,
  );
  return { ok: true as const, id: Number(result.lastInsertRowid) };
};

export const updateNewspaper = (userId: number, newspaperId: number, input: Record<string, unknown>) => {
  const existing = db.prepare('SELECT * FROM newspapers WHERE id = ? AND user_id = ?').get(newspaperId, userId) as any;
  if (!existing) return { ok: false as const, error: 'newspaper_not_found' };
  const name = input.name === undefined ? String(existing.name) : cleanText(input.name, 120);
  if (!name) return { ok: false as const, error: 'name_required' };
  db.prepare(`
    UPDATE newspapers SET name = ?, editorial_brief = ?, interests = ?, preferences = ?, style = ?, enabled = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    name,
    input.editorial_brief === undefined ? existing.editorial_brief : cleanText(input.editorial_brief),
    input.interests === undefined ? existing.interests : cleanText(input.interests),
    input.preferences === undefined ? existing.preferences : cleanText(input.preferences),
    input.style === undefined ? existing.style : cleanStyle(input.style),
    input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0),
    Math.floor(Date.now() / 1000),
    newspaperId,
    userId,
  );
  return { ok: true as const };
};

export const listNewspaperIssues = (userId: number, newspaperId: number, limit = 30): NewspaperIssueSummaryDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)));
  const rows = db.prepare(`
    SELECT * FROM newspaper_issues
    WHERE user_id = ? AND newspaper_id = ?
    ORDER BY issue_number DESC LIMIT ?
  `).all(userId, newspaperId, safeLimit) as any[];
  return rows.map(mapIssueSummary);
};

export const getNewspaperIssue = (userId: number, issueId: number): NewspaperIssueDto | null => {
  const row = db.prepare('SELECT * FROM newspaper_issues WHERE id = ? AND user_id = ?').get(issueId, userId) as any;
  if (!row) return null;
  try {
    return { ...mapIssueSummary(row), document: parseDocument(String(row.document_json)) };
  } catch {
    return null;
  }
};

export const deleteNewspaperIssue = (userId: number, issueId: number) => db
  .prepare('DELETE FROM newspaper_issues WHERE id = ? AND user_id = ?')
  .run(issueId, userId)
  .changes > 0;

const demoDocument = (issueNumber: number): NewspaperIssueDocument => ({
  version: 1,
  title: 'Chatter Daily',
  subtitle: `Утренний выпуск · №${issueNumber}`,
  date: new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' }).format(new Date()),
  blocks: [
    { id: 'weather', type: 'weather', title: 'Погода на день', location: 'Томск', condition: 'Переменная облачность', details: 'Без сильного ветра и осадков.', periods: [
      { label: 'Утро', temperature: 9, condition: 'Облачно' },
      { label: 'День', temperature: 14, condition: 'Без дождя' },
      { label: 'Вечер', temperature: 10, condition: 'Прохладно' },
    ], priority: 100 },
    { id: 'hero-ai', type: 'hero', title: issueNumber % 2 === 0 ? 'Интерфейсы учатся показывать работу агентов' : 'Агенты становятся частью обычных приложений', summary: issueNumber % 2 === 0 ? 'Второй тестовый выпуск посвящён прозрачным фоновым процессам: пользователь видит прогресс, но интерфейс не мешает основной работе.' : 'Главная тема выпуска — как небольшие специализированные агенты превращают сложные процессы в понятные пользовательские функции.', priority: 90, sources: [{ title: 'OpenAI Research', url: 'https://openai.com/research/' }] },
    { id: 'brief', type: 'news_list', title: 'Коротко', items: [
      { title: 'React продолжает улучшать серверный рендеринг', summary: 'Экосистема постепенно стандартизирует новые подходы.', url: 'https://react.dev/blog' },
      { title: 'Новый взгляд на космические телескопы', summary: 'Инженеры тестируют инструменты следующего поколения.', url: 'https://www.nasa.gov/' },
      { title: 'Инструменты разработки становятся нагляднее', summary: 'Фоновые операции всё чаще показывают живой прогресс без лишних модальных окон.', url: 'https://github.blog/' },
    ], priority: 70 },
    { id: 'deep-dive', type: 'article', title: 'Почему маленькие агенты лучше одного огромного контекста', summary: 'Разделение исследования на независимые задания снижает шум: редактор получает компактные факты и источники, а не десятки сырых страниц.', priority: 60, sources: [{ title: 'OpenAI Research', url: 'https://openai.com/research/' }] },
    { id: 'cat', type: 'image', title: 'Кот дня', caption: 'Редакция напоминает: иногда производительность повышается после десяти минут ничегонеделания.', prompt: 'sleepy newsroom cat', priority: 20 },
    { id: 'humor', type: 'humor', title: 'На последней полосе', text: 'Планёрка закончилась успешно: все задачи перенесли на следующую планёрку.', priority: 10 },
  ],
});

export const createDemoNewspaperIssue = (userId: number): NewspaperIssueDto => db.transaction(() => {
  let newspaper = db.prepare('SELECT id FROM newspapers WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId) as { id: number } | undefined;
  if (!newspaper) {
    const created = createNewspaper(userId, {
      name: 'Chatter Daily',
      editorial_brief: 'Краткая утренняя газета. В новостных блоках должны быть только проверяемые события с источниками; личные планы, советы и рекомендации новостями не считаются.',
      style: 'classic',
    });
    if (!created.ok) throw new Error(created.error);
    newspaper = { id: created.id };
  }
  const current = db.prepare('SELECT COALESCE(MAX(issue_number), 0) AS n FROM newspaper_issues WHERE newspaper_id = ?')
    .get(newspaper.id) as { n: number };
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT INTO newspaper_issues (newspaper_id, user_id, issue_number, title, subtitle, status, document_json, published_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
  `);
  const issueNumbers = Number(current.n) === 0 ? [1, 2] : [Number(current.n) + 1];
  let lastIssueId = 0;
  for (const issueNumber of issueNumbers) {
    const document = demoDocument(issueNumber);
    const result = insert.run(newspaper.id, userId, issueNumber, document.title, document.subtitle || '', JSON.stringify(document), now, now);
    lastIssueId = Number(result.lastInsertRowid);
  }
  db.prepare('UPDATE newspapers SET updated_at = ? WHERE id = ?').run(now, newspaper.id);
  const issue = getNewspaperIssue(userId, lastIssueId);
  if (!issue) throw new Error('newspaper_issue_create_failed');
  return issue;
})();
