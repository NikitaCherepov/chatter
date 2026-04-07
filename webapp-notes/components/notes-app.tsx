"use client";

import { FormEvent, useEffect, useMemo, useState } from 'react';

type NoteItem = {
  id: number;
  title: string;
  content: string;
  created_at: number;
};

type NotesResponse = {
  items: NoteItem[];
  total: number;
  limit: number;
  offset: number;
  query: string;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

const PAGE_SIZE = 20;

const formatTs = (ts: number) => {
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  return new Date(ts * 1000).toLocaleString('ru-RU');
};

const preview = (value: string, max = 160) => {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
};

export function NotesApp() {
  const [initData, setInitData] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<NoteItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg?.ready) tg.ready();
    if (tg?.expand) tg.expand();
    setInitData(tg?.initData || '');
  }, []);

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const page = useMemo(() => Math.floor(offset / PAGE_SIZE) + 1, [offset]);
  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  const loadNotes = async (nextOffset = 0, nextQuery = query) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(nextOffset));
      if (nextQuery.trim()) params.set('query', nextQuery.trim());

      const res = await fetch(`/api/notes?${params.toString()}`, {
        headers: { 'x-telegram-init-data': initData },
        cache: 'no-store',
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const data = (await res.json()) as NotesResponse;
      setItems(data.items || []);
      setTotal(data.total || 0);
      setOffset(data.offset || 0);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initData) return;
    loadNotes(0, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initData]);

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (!content.trim()) {
      setError('Текст заметки обязателен.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-init-data': initData,
        },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      setTitle('');
      setContent('');
      await loadNotes(0, query);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const onDelete = async (id: number) => {
    const ok = window.confirm(`Удалить заметку #${id}?`);
    if (!ok) return;

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: 'DELETE',
        headers: { 'x-telegram-init-data': initData },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const nextOffset = items.length === 1 && offset >= PAGE_SIZE ? offset - PAGE_SIZE : offset;
      await loadNotes(nextOffset, query);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <h1>📝 Заметки</h1>

      <section className="card">
        <form className="grid" onSubmit={onCreate}>
          <input
            placeholder="Заголовок (необязательно)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
          <textarea
            placeholder="Текст заметки"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={2000}
            required
          />
          <button disabled={loading} type="submit">Добавить заметку</button>
        </form>
      </section>

      <section className="card grid">
        <div className="grid grid-2">
          <input
            placeholder="Поиск по заголовку и тексту"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={120}
          />
          <div className="inline-actions">
            <button className="secondary" disabled={loading} onClick={() => loadNotes(0, query)} type="button">Искать</button>
            <button className="secondary" disabled={loading} onClick={() => { setQuery(''); loadNotes(0, ''); }} type="button">Сбросить</button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Заметка</th>
                <th>Создано</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">Нет данных</td>
                </tr>
              )}
              {items.map((item) => (
                <tr key={item.id}>
                  <td>#{item.id}</td>
                  <td>
                    {item.title?.trim() ? <div><strong>{preview(item.title, 60)}</strong></div> : null}
                    <div>{preview(item.content, 180)}</div>
                  </td>
                  <td className="muted">{formatTs(item.created_at)}</td>
                  <td>
                    <button className="danger" disabled={loading} onClick={() => onDelete(item.id)} type="button">Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="inline-actions">
          <button className="secondary" disabled={!canPrev || loading} onClick={() => loadNotes(Math.max(0, offset - PAGE_SIZE), query)} type="button">← Назад</button>
          <button className="secondary" disabled={!canNext || loading} onClick={() => loadNotes(offset + PAGE_SIZE, query)} type="button">Вперед →</button>
        </div>
        <div className="muted">Страница {page}/{totalPages}, всего: {total}</div>
      </section>

      {error ? <section className="card" style={{ borderColor: '#e53e3e' }}><strong>Ошибка:</strong> {error}</section> : null}
      {!initData ? <section className="card"><span className="muted">WebApp initData не найден. Открывай страницу из Telegram-кнопки `web_app`.</span></section> : null}
    </main>
  );
}
