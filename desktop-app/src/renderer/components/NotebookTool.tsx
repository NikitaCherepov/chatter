import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { subscribeWidgetData, setNotebookDraftState } from '../lib/tools';
import s from './NotebookTool.module.scss';

const TITLE_MAX = 120;

type View = 'list' | 'editor';

type Props = {
  contentMax: number;
};

const slideVariants = {
  enter: { x: 30, opacity: 0 },
  center: { x: 0, opacity: 1 },
  exit: { x: -30, opacity: 0 },
};

const slideTransition = { duration: 0.18, ease: 'easeOut' as const };

export function NotebookTool({ contentMax }: Props) {
  const [view, setView] = useState<View>('list');
  const [notes, setNotes] = useState<api.NoteDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Editor state
  const [editId, setEditId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [originalTitle, setOriginalTitle] = useState('');
  const [originalContent, setOriginalContent] = useState('');

  const isEditing = editId !== null;
  const isDirty = title.trim() !== originalTitle.trim() || content.trim() !== originalContent.trim();

  const loadNotes = async (query = '') => {
    setLoading(true);
    try {
      const res = await api.listNotes(50, 0, query);
      setNotes(res.notes ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      console.error('Failed to load notes:', err);
      setNotes([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadNotes(); }, []);

  // Subscribe to widget data commands (from bot)
  useEffect(() => {
    const unsub = subscribeWidgetData('notebook', async (cmd) => {
      if (cmd.type === 'set_draft') {
        setEditId(null);
        setTitle(cmd.title || '');
        setContent(cmd.content || '');
        setOriginalTitle('');
        setOriginalContent('');
        setView('editor');
      }
      if (cmd.type === 'open_note' && cmd.noteId) {
        try {
          const res = await api.getNoteById(cmd.noteId);
          if (res?.note) openEditor(res.note);
        } catch (err) {
          console.error('Failed to open note by ID from bot:', err);
        }
      }
    });
    return unsub;
  }, []);

  const textareaElRef = useRef<HTMLTextAreaElement | null>(null);

  const resizeTextarea = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 350)}px`;
  }, []);

  // callback-ref: fires when textarea mounts (list → editor transition)
  const textareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaElRef.current = node;
    if (node) resizeTextarea(node);
  }, [resizeTextarea]);

  // Resize when content changes externally (openEditor, open_note from bot)
  useEffect(() => {
    const el = textareaElRef.current;
    if (el && content) resizeTextarea(el);
  }, [content, resizeTextarea]);

  // Expose draft state for bot to read
  useEffect(() => {
    setNotebookDraftState({
      title,
      content,
      isOpen: view === 'editor',
    });
  }, [title, content, view]);

  const openEditor = (note?: api.NoteDto) => {
    if (note) {
      setEditId(note.id);
      setTitle(note.title || '');
      setContent(note.content || '');
      setOriginalTitle(note.title || '');
      setOriginalContent(note.content || '');
    } else {
      setEditId(null);
      setTitle('');
      setContent('');
      setOriginalTitle('');
      setOriginalContent('');
    }
    setView('editor');
  };

  const backToList = () => {
    setView('list');
  };

  const handleSelectNote = async (id: number) => {
    try {
      const res = await api.getNoteById(id);
      if (res?.note) openEditor(res.note);
    } catch (err) {
      console.error('Failed to load note:', err);
    }
  };

  const handleSave = async () => {
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    if (!cleanContent) {
      toast.error('Текст заметки обязателен');
      return;
    }

    setSaving(true);
    try {
      if (isEditing && editId !== null) {
        await api.deleteNote(editId);
        const res = await api.createNote(cleanTitle, cleanContent);
        if (res?.error) {
          if (res.error === 'notes_limit') toast.error('Лимит заметок исчерпан');
          else if (res.error === 'content_too_long') toast.error('Текст слишком длинный');
          else toast.error('Не удалось сохранить');
          return;
        }
        toast.success('Заметка сохранена');
      } else {
        const res = await api.createNote(cleanTitle, cleanContent);
        if (res?.error) {
          if (res.error === 'notes_limit') toast.error('Лимит заметок исчерпан');
          else if (res.error === 'content_too_long') toast.error('Текст слишком длинный');
          else toast.error('Не удалось создать заметку');
          return;
        }
        toast.success('Заметка создана');
      }
      await loadNotes(searchQuery);
      backToList();
    } catch (err) {
      console.error('Failed to save note:', err);
      toast.error('Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.deleteNote(id);
      toast.success('Заметка удалена');
      await loadNotes(searchQuery);
      backToList();
    } catch (err) {
      console.error('Failed to delete note:', err);
      toast.error('Не удалось удалить');
    }
  };

  const handleSearch = () => { loadNotes(searchQuery); };
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSearch(); }
  };

  const preview = (text: string, max = 60) => {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return 'Пусто';
    return compact.length <= max ? compact : compact.slice(0, max) + '...';
  };

  const formatTs = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  };

  return (
    <div className={s.root}>
      <AnimatePresence mode="wait">
        {view === 'list' ? (
          <motion.div
            key="list"
            className={s.listView}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={slideTransition}
          >
            {/* Search + create */}
            <div className={s.listHeader}>
              <div className={s.searchRow}>
                <input
                  className={s.searchInput}
                  type="text"
                  placeholder="Поиск..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                />
                <button className={s.searchBtn} onClick={handleSearch} title="Искать">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
              </div>
              <button className={s.createBtn} onClick={() => openEditor()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Создать
              </button>
            </div>

            {/* Notes */}
            <div className={s.notesList}>
              {loading && <div className={s.hint}>Загрузка...</div>}
              {!loading && notes.length === 0 && (
                <div className={s.hint}>{searchQuery ? 'Ничего не найдено' : 'Пока нет заметок'}</div>
              )}
              {!loading && notes.map((note) => (
                <div
                  key={note.id}
                  className={s.noteItem}
                  onClick={() => handleSelectNote(note.id)}
                >
                  <div className={s.noteItemHeader}>
                    <span className={s.noteItemTitle}>{note.title ? preview(note.title, 30) : `Заметка #${note.id}`}</span>
                    <span className={s.noteItemDate}>{formatTs(note.updated_at || note.created_at)}</span>
                  </div>
                  <div className={s.noteItemPreview}>{preview(note.content, 80)}</div>
                  <button
                    className={s.noteItemDelete}
                    onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
                    title="Удалить"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="editor"
            className={s.editorView}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={slideTransition}
          >
            {/* Editor header */}
            <div className={s.editorHeader}>
              <button className={s.backBtn} onClick={backToList} title="Назад">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <span className={s.editorTitle}>
                {isEditing ? `#${editId}` : 'Новая заметка'}
              </span>
              {isEditing && (
                <button className={s.deleteBtn} onClick={() => handleDelete(editId!)} title="Удалить">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>

            {/* Form */}
            <div className={s.editorBody}>
              <input
                className={s.titleInput}
                type="text"
                placeholder="Заголовок..."
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                autoFocus={!isEditing}
              />

              <textarea
                ref={textareaRef}
                className={s.contentInput}
                placeholder="Текст заметки..."
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 350)}px`;
                }}
                maxLength={contentMax}
                autoFocus={isEditing}
              />

              <div className={s.editorFooter}>
                <span className={s.charCount}>{content.length}/{contentMax}</span>
                <button
                  className={s.saveBtn}
                  onClick={handleSave}
                  disabled={saving || !content.trim() || (isEditing && !isDirty)}
                >
                  {saving ? '...' : isEditing ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
