"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { setAppLanguage } from "../i18n";

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
  language: string | null;
};

type SingleNoteResponse = {
  note: NoteItem;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        initDataUnsafe?: {
          user?: { language_code?: string };
        };
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

const PAGE_SIZE = 20;
const TITLE_MAX = 120;
const CONTENT_MAX = 2000;

const formatTs = (ts: number, language: string) => {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts * 1000).toLocaleString(language);
};

const preview = (value: string, emptyLabel: string, max = 110) => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return emptyLabel;
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
};

export function NotesApp() {
  const { t, i18n } = useTranslation();
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
    const value = tg?.initData || "";
    setInitData(value || "");
    void setAppLanguage(tg?.initDataUnsafe?.user?.language_code);
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

  const readApiError = async (response: Response) => {
    let code = "";
    try {
      const payload = await response.json() as { error?: string };
      code = payload.error || "";
    } catch {
      // Use the generic localized error below.
    }
    if (code) {
      const translated = t(`errors.api.${code}`);
      if (translated !== `errors.api.${code}`) return translated;
    }
    return t("errors.requestFailed", { status: response.status });
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
        throw new Error(await readApiError(res));
      }

      const data = (await res.json()) as NotesResponse;
      const nextItems = data.items || [];

      setItems(nextItems);
      setTotal(data.total || 0);
      setOffset(data.offset || 0);
      if (data.language) await setAppLanguage(data.language);

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
        throw new Error(await readApiError(res));
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
      setError(t("validation.contentRequired"));
      return;
    }
    if (cleanTitle.length > TITLE_MAX) {
      setError(t("validation.titleTooLong", { max: TITLE_MAX }));
      return;
    }
    if (cleanContent.length > CONTENT_MAX) {
      setError(t("validation.contentTooLong", { max: CONTENT_MAX }));
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
        throw new Error(await readApiError(res));
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
    const ok = window.confirm(t("confirm.delete", { id }));
    if (!ok) return;

    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: "DELETE",
        headers: { "x-telegram-init-data": initData },
      });

      if (!res.ok) {
        throw new Error(await readApiError(res));
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
        <h1>{t("header.title")}</h1>
        <p className="muted">{t("header.subtitle")}</p>
      </header>

      <section className="card toolbar">
        <div className="grid grid-2">
          <input
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={120}
          />
          <div className="inline-actions">
            <button className="secondary" disabled={loading || saving} onClick={() => loadNotes(0, query)} type="button">
              {t("search.submit")}
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
              {t("search.reset")}
            </button>
            <button className="secondary" disabled={loading || saving} onClick={resetDraftToCreate} type="button">
              {t("search.new")}
            </button>
          </div>
        </div>
      </section>

      <section className="layout">
        <section className="card notes-list">
          <div className="list-header">
            <strong>{t("list.title")}</strong>
            <span className="muted">{t("list.total", { count: total })}</span>
          </div>
          <div className="notes-scroll">
            {items.length === 0 ? <div className="muted empty">{t("list.empty")}</div> : null}
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
                    <span className="muted">{formatTs(item.updated_at || item.created_at, i18n.resolvedLanguage || "en")}</span>
                  </div>
                  {item.title?.trim() ? <div className="note-title">{preview(item.title, t("common.empty"), 60)}</div> : null}
                  <div className="note-preview">{preview(item.content, t("common.empty"), 140)}</div>
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
                      {t("list.delete")}
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
              {t("list.previous")}
            </button>
            <button
              className="secondary"
              disabled={!canNext || loading || saving}
              onClick={() => loadNotes(offset + PAGE_SIZE, query)}
              type="button"
            >
              {t("list.next")}
            </button>
          </div>
          <div className="muted">{t("list.page", { page, totalPages })}</div>
        </section>

        <section className="card editor">
          <div className="editor-head">
            <strong>{isEditMode ? t("editor.editing", { id: selectedId }) : t("editor.new")}</strong>
            {isEditMode ? (
              <button className="secondary ghost" type="button" onClick={resetDraftToCreate} disabled={loading || saving}>
                {t("editor.close")}
              </button>
            ) : null}
          </div>
          <form className="grid" onSubmit={onSave}>
            <label className="field">
              <span>{t("editor.title")}</span>
              <input
                placeholder={t("editor.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
              />
              <small className="muted">{title.length}/{TITLE_MAX}</small>
            </label>

            <label className="field">
              <span>{t("editor.content")}</span>
              <textarea
                placeholder={t("editor.contentPlaceholder")}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={CONTENT_MAX}
                required
              />
              <small className="muted">{content.length}/{CONTENT_MAX}</small>
            </label>

            <div className="inline-actions">
              <button type="submit" disabled={loading || saving || !content.trim() || (isEditMode && !isDirty)}>
                {isEditMode ? t("editor.saveChanges") : t("editor.create")}
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
                {t("editor.cancel")}
              </button>
              {isEditMode ? (
                <button className="danger" type="button" disabled={loading || saving} onClick={() => onDelete(selectedId)}>
                  {t("editor.delete")}
                </button>
              ) : null}
            </div>
          </form>
        </section>
      </section>

      {error ? (
        <section className="card error-card">
          <strong>{t("errors.title")}</strong> {error}
        </section>
      ) : null}
      {!initData ? (
        <section className="card">
          <span className="muted">{t("errors.initDataMissing")}</span>
        </section>
      ) : null}
    </main>
  );
}
