import { NextRequest, NextResponse } from 'next/server';
import { deleteNote, getNoteById, updateNote } from '../../../../lib/notes-repo';
import { verifyAndExtractTelegramUser } from '../../../../lib/telegram-auth';

const TITLE_MAX = 120;
const CONTENT_MAX = 2000;
const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

const parseNoteId = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const noteId = Number(id);
  if (!Number.isFinite(noteId) || noteId <= 0) return null;
  return Math.floor(noteId);
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const initData = request.headers.get('x-telegram-init-data') || '';
  const auth = verifyAndExtractTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = await parseNoteId(context);
  if (!noteId) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const note = getNoteById(auth.userId, noteId);
  if (!note) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 });
  }

  return NextResponse.json({ note });
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const initData = request.headers.get('x-telegram-init-data') || '';
  const auth = verifyAndExtractTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = await parseNoteId(context);
  if (!noteId) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

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

  const note = updateNote(auth.userId, noteId, title, content);
  if (!note) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 });
  }

  return NextResponse.json({ note });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const initData = request.headers.get('x-telegram-init-data') || '';
  const auth = verifyAndExtractTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = await parseNoteId(context);
  if (!noteId) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const deleted = deleteNote(auth.userId, noteId);
  if (!deleted) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
