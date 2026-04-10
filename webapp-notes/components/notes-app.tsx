"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type NoteItem = {
  id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
};

type NotesResponse = {
  items: NoteItem[];
  total: number;
  limit: number;
  offset: number;
  query: string;
};

type SingleNoteResponse = {
  note: NoteItem;
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
const TITLE_MAX = 120;
const CONTENT_MAX = 2000;

const formatTs = (ts: number) => {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts * 1000).toLocaleString("ru-RU");
};

const preview = (value: string, max = 110) => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "Пусто";
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
};

const extractInitDataFromLaunchParams = () => {
  const fromSearch = new URLSearchParams(window.location.search).get("tgWebAppData") || "";
  if (fromSearch) return fromSearch;

  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const fromHash = new URLSearchParams(hash).get("tgWebAppData") || "";
  return fromHash;
};

export function NotesApp() {
  const [initData, setInitData] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<NoteItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [originalTitle, setOriginalTitle] = useState("");
  const [originalContent, setOriginalContent] = useState("");

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg?.ready) tg.ready();
    if (tg?.expand) tg.expand();
    const value = tg?.initData || extractInitDataFromLaunchParams();
    setInitData(value || "");
  }, []);

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const page = useMemo(() => Math.floor(offset / PAGE_SIZE) + 1, [offset]);
  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const isEditMode = selectedId !== null;
  const isDirty = title.trim() !== originalTitle.trim() || content.trim() !== originalContent.trim();

  const resetDraftToCreate = () => {
    setSelectedId(null);
    setTitle("");
    setContent("");
    setOriginalTitle("");
    setOriginalContent("");
  };

  const openNoteInEditor = (note: NoteItem) => {
    setSelectedId(note.id);
    setTitle(note.title || "");
    setContent(note.content || "");
    setOriginalTitle(note.title || "");
    setOriginalContent(note.content || "");
    setError("");
  };

  const loadNotes = async (nextOffset = 0, nextQuery = query) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(nextOffset));
      if (nextQuery.trim()) params.set("query", nextQuery.trim());

      const res = await fetch(`/api/notes?${params.toString()}`, {
        headers: { "x-telegram-init-data": initData },
        cache: "no-store",
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const data = (await res.json()) as NotesResponse;
      const nextItems = data.items || [];

      setItems(nextItems);
      setTotal(data.total || 0);
      setOffset(data.offset || 0);

      if (selectedId !== null) {
        const selected = nextItems.find((item) => item.id === selectedId);
        if (selected && !isDirty) {
          openNoteInEditor(selected);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!initData) return;
    loadNotes(0, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initData]);

  const onSelectNote = async (id: number) => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/notes/${id}`, {
        headers: { "x-telegram-init-data": initData },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const data = (await res.json()) as SingleNoteResponse;
      openNoteInEditor(data.note);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const onSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const cleanTitle = title.trim();
    const cleanContent = content.trim();

    if (!cleanContent) {
      setError("Текст заметки обязателен.");
      return;
    }
    if (cleanTitle.length > TITLE_MAX) {
      setError(`Заголовок должен быть не длиннее ${TITLE_MAX} символов.`);
      return;
    }
    if (cleanContent.length > CONTENT_MAX) {
      setError(`Текст должен быть не длиннее ${CONTENT_MAX} символов.`);
      return;
    }

    setSaving(true);
    try {
      const isUpdate = selectedId !== null;
      const endpoint = isUpdate ? `/api/notes/${selectedId}` : "/api/notes";
      const method = isUpdate ? "PUT" : "POST";
      const res = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-telegram-init-data": initData,
        },
        body: JSON.stringify({ title: cleanTitle, content: cleanContent }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const payload = (await res.json()) as { note?: NoteItem };
      const note = payload.note;
      if (note) {
        openNoteInEditor(note);
      }

      await loadNotes(isUpdate ? offset : 0, query);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: number) => {
    const ok = window.confirm(`Удалить заметку #${id}?`);
    if (!ok) return;

    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: "DELETE",
        headers: { "x-telegram-init-data": initData },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      if (selectedId === id) {
        resetDraftToCreate();
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
      <header className="page-header">
        <h1>Мои заметки</h1>
        <p className="muted">Открывай, редактируй и сохраняй заметки прямо в WebApp.</p>
      </header>

      <section className="card toolbar">
        <div className="grid grid-2">
          <input
            placeholder="Поиск по заголовку и тексту"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={120}
          />
          <div className="inline-actions">
            <button className="secondary" disabled={loading || saving} onClick={() => loadNotes(0, query)} type="button">
              Найти
            </button>
            <button
              className="secondary"
              disabled={loading || saving}
              onClick={() => {
                setQuery("");
                loadNotes(0, "");
              }}
              type="button"
            >
              Сбросить
            </button>
            <button className="secondary" disabled={loading || saving} onClick={resetDraftToCreate} type="button">
              Новая
            </button>
          </div>
        </div>
      </section>

      <section className="layout">
        <section className="card notes-list">
          <div className="list-header">
            <strong>Список заметок</strong>
            <span className="muted">Всего: {total}</span>
          </div>
          <div className="notes-scroll">
            {items.length === 0 ? <div className="muted empty">Заметок пока нет</div> : null}
            {items.map((item) => {
              const active = selectedId === item.id;
              return (
                <article
                  key={item.id}
                  className={`note-row${active ? " active" : ""}`}
                  onClick={() => onSelectNote(item.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onSelectNote(item.id);
                  }}
                >
                  <div className="note-top">
                    <strong>#{item.id}</strong>
                    <span className="muted">{formatTs(item.updated_at || item.created_at)}</span>
                  </div>
                  {item.title?.trim() ? <div className="note-title">{preview(item.title, 60)}</div> : null}
                  <div className="note-preview">{preview(item.content, 140)}</div>
                  <div className="row-actions">
                    <button
                      className="danger ghost"
                      type="button"
                      disabled={loading || saving}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(item.id);
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="inline-actions pager">
            <button
              className="secondary"
              disabled={!canPrev || loading || saving}
              onClick={() => loadNotes(Math.max(0, offset - PAGE_SIZE), query)}
              type="button"
            >
              Назад
            </button>
            <button
              className="secondary"
              disabled={!canNext || loading || saving}
              onClick={() => loadNotes(offset + PAGE_SIZE, query)}
              type="button"
            >
              Далее
            </button>
          </div>
          <div className="muted">Страница {page}/{totalPages}</div>
        </section>

        <section className="card editor">
          <div className="editor-head">
            <strong>{isEditMode ? `Редактирование #${selectedId}` : "Новая заметка"}</strong>
            {isEditMode ? (
              <button className="secondary ghost" type="button" onClick={resetDraftToCreate} disabled={loading || saving}>
                Закрыть
              </button>
            ) : null}
          </div>
          <form className="grid" onSubmit={onSave}>
            <label className="field">
              <span>Заголовок</span>
              <input
                placeholder="Короткий заголовок (необязательно)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
              />
              <small className="muted">{title.length}/{TITLE_MAX}</small>
            </label>

            <label className="field">
              <span>Текст заметки</span>
              <textarea
                placeholder="Пиши заметку здесь..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={CONTENT_MAX}
                required
              />
              <small className="muted">{content.length}/{CONTENT_MAX}</small>
            </label>

            <div className="inline-actions">
              <button type="submit" disabled={loading || saving || !content.trim() || (isEditMode && !isDirty)}>
                {isEditMode ? "Сохранить изменения" : "Создать заметку"}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={loading || saving}
                onClick={() => {
                  if (isEditMode) {
                    setTitle(originalTitle);
                    setContent(originalContent);
                    return;
                  }
                  setTitle("");
                  setContent("");
                }}
              >
                Отменить
              </button>
              {isEditMode ? (
                <button className="danger" type="button" disabled={loading || saving} onClick={() => onDelete(selectedId)}>
                  Удалить
                </button>
              ) : null}
            </div>
          </form>
        </section>
      </section>

      {error ? (
        <section className="card error-card">
          <strong>Ошибка:</strong> {error}
        </section>
      ) : null}
      {!initData ? (
        <section className="card">
          <span className="muted">initData не найден. Откройте страницу через кнопку `web_app` в Telegram.</span>
        </section>
      ) : null}
    </main>
  );
}
