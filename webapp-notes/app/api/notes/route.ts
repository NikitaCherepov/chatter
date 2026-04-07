import { NextRequest, NextResponse } from 'next/server';
import { createNote, listNotes } from '../../../lib/notes-repo';
import { verifyAndExtractTelegramUser } from '../../../lib/telegram-auth';

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
const QUERY_MAX = 120;
const TITLE_MAX = 120;
const CONTENT_MAX = 2000;

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

const getAuth = (request: NextRequest) => {
  const initData = request.headers.get('x-telegram-init-data') || '';
  return verifyAndExtractTelegramUser(initData);
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
  return NextResponse.json({ items, total, limit, offset, query });
}

export async function POST(request: NextRequest) {
  const auth = getAuth(request);
  if (!auth) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const payload = (body || {}) as { title?: string; content?: string };
  const title = (payload.title || '').trim();
  const content = (payload.content || '').trim();

  if (!content || content.length > CONTENT_MAX) {
    return NextResponse.json({ error: `content должен быть 1..${CONTENT_MAX} символов` }, { status: 400 });
  }
  if (title.length > TITLE_MAX) {
    return NextResponse.json({ error: `title должен быть 0..${TITLE_MAX} символов` }, { status: 400 });
  }

  const note = createNote(auth.userId, title, content);
  return NextResponse.json({ note }, { status: 201 });
}
