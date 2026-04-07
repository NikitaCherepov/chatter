import { NextRequest, NextResponse } from 'next/server';
import { deleteNote } from '../../../../lib/notes-repo';
import { verifyAndExtractTelegramUser } from '../../../../lib/telegram-auth';

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

export async function DELETE(request: NextRequest, context: { params: { id: string } }) {
  const initData = request.headers.get('x-telegram-init-data') || '';
  const auth = verifyAndExtractTelegramUser(initData);
  if (!auth) return unauthorized();

  const noteId = Number(context.params.id);
  if (!Number.isFinite(noteId) || noteId <= 0) {
    return NextResponse.json({ error: 'Некорректный id' }, { status: 400 });
  }

  const deleted = deleteNote(auth.userId, Math.floor(noteId));
  if (!deleted) {
    return NextResponse.json({ error: 'Заметка не найдена' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
