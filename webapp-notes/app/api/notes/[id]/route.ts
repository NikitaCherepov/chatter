import { NextRequest, NextResponse } from 'next/server';
import { deleteNote, getNoteById, updateNote } from '../../../../lib/notes-repo';
import { readLimitedJson } from '../../../../lib/request-json';
import { verifyAndAuthorizeTelegramUser } from '../../../../lib/telegram-auth';

const TITLE_MAX = 120;
const CONTENT_MAX = 2000;
const JSON_BODY_MAX_BYTES = 16 * 1024;
const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });

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
  const auth = verifyAndAuthorizeTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = await parseNoteId(context);
  if (!noteId) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const note = getNoteById(auth.userId, noteId);
  if (!note) {
    return NextResponse.json({ error: 'note_not_found' }, { status: 404 });
  }

  return NextResponse.json({ note });
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const initData = request.headers.get('x-telegram-init-data') || '';
  const auth = verifyAndAuthorizeTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = await parseNoteId(context);
  if (!noteId) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

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

  const note = updateNote(auth.userId, noteId, title, content);
  if (!note) {
    return NextResponse.json({ error: 'note_not_found' }, { status: 404 });
  }

  return NextResponse.json({ note });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const initData = request.headers.get('x-telegram-init-data') || '';
  const auth = verifyAndAuthorizeTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = await parseNoteId(context);
  if (!noteId) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const deleted = deleteNote(auth.userId, noteId);
  if (!deleted) {
    return NextResponse.json({ error: 'note_not_found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
