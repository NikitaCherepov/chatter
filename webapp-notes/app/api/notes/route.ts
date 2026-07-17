import { NextRequest, NextResponse } from 'next/server';
import { createNote, listNotes } from '../../../lib/notes-repo';
import { readLimitedJson } from '../../../lib/request-json';
import { verifyAndAuthorizeTelegramUser } from '../../../lib/telegram-auth';

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
const QUERY_MAX = 120;
const TITLE_MAX = 120;
const CONTENT_MAX = 2000;
const JSON_BODY_MAX_BYTES = 16 * 1024;

const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });

const getAuth = (request: NextRequest) => {
  const initData = request.headers.get('x-telegram-init-data') || '';
  return verifyAndAuthorizeTelegramUser(initData);
};

export async function GET(request: NextRequest) {
  const auth = getAuth(request);
  if (!auth) return unauthorized();

  const url = new URL(request.url);
  const queryRaw = (url.searchParams.get('query') || '').trim();
  const query = queryRaw.slice(0, QUERY_MAX);

  const limitRaw = Number(url.searchParams.get('limit') || LIMIT_DEFAULT);
  const offsetRaw = Number(url.searchParams.get('offset') || 0);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(LIMIT_MAX, Math.floor(limitRaw))) : LIMIT_DEFAULT;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

  const { items, total } = listNotes(auth.userId, query, limit, offset);
  return NextResponse.json({ items, total, limit, offset, query, language: auth.language });
}

export async function POST(request: NextRequest) {
  const auth = getAuth(request);
  if (!auth) return unauthorized();

  const json = await readLimitedJson(request, JSON_BODY_MAX_BYTES);
  if (!json.ok) {
    return NextResponse.json({ error: json.error }, { status: json.status });
  }

  if (!json.value || typeof json.value !== 'object' || Array.isArray(json.value)) {
    return NextResponse.json({ error: 'invalid_json_object' }, { status: 400 });
  }

  const payload = json.value as Record<string, unknown>;
  if (payload.title !== undefined && typeof payload.title !== 'string') {
    return NextResponse.json({ error: 'invalid_title' }, { status: 400 });
  }
  if (typeof payload.content !== 'string') {
    return NextResponse.json({ error: 'invalid_content' }, { status: 400 });
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const content = payload.content.trim();

  if (!content || content.length > CONTENT_MAX) {
    return NextResponse.json({ error: 'invalid_content_length' }, { status: 400 });
  }
  if (title.length > TITLE_MAX) {
    return NextResponse.json({ error: 'invalid_title_length' }, { status: 400 });
  }

  const note = createNote(auth.userId, title, content);
  return NextResponse.json({ note }, { status: 201 });
}
