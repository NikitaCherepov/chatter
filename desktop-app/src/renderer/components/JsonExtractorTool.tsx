import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { registerToolNav } from '../lib/tools';
import s from './JsonExtractorTool.module.scss';

const DEFAULT_EXAMPLE = `{
  "name": "",
  "type": "",
  "description": ""
}`;

const formatNumber = (value: number) => new Intl.NumberFormat().format(value);
const statusIsActive = (status: api.ExtractionJobStatus) =>
  status === 'pending' || status === 'processing';

export function JsonExtractorTool() {
  const { i18n } = useTranslation();
  const ru = i18n.language.toLowerCase().startsWith('ru');
  const tr = useCallback((en: string, russian: string) => ru ? russian : en, [ru]);
  const statusLabel = useCallback((status: api.ExtractionJobStatus | api.ExtractionItemStatus) => ({
    pending: tr('Pending', 'Ожидает'),
    processing: tr('Processing', 'Обрабатывается'),
    completed: tr('Completed', 'Готово'),
    failed: tr('Failed', 'Ошибка'),
    cancelled: tr('Cancelled', 'Отменено'),
    incomplete: tr('Incomplete', 'Не завершено'),
    review: tr('Review', 'На проверке'),
    confirmed: tr('Confirmed', 'Подтверждено'),
  }[status]), [tr]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<api.ExtractionFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<api.ExtractionFile | null>(null);
  const [jobs, setJobs] = useState<api.ExtractionJobSummary[]>([]);
  const [job, setJob] = useState<api.ExtractionJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [exampleText, setExampleText] = useState(DEFAULT_EXAMPLE);
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(1);
  const [autoConfirm, setAutoConfirm] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  const loadFiles = useCallback(async () => {
    try {
      const result = await api.listExtractionFiles();
      setFiles(result.files);
      setSelectedFile(current =>
        current ? result.files.find(file => file.id === current.id) || null : null,
      );
    } catch (error) {
      console.error('[json-extractor] load files failed:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const openFile = useCallback(async (file: api.ExtractionFile) => {
    setSelectedFile(file);
    setJob(null);
    setStartPage(1);
    setEndPage(file.page_count);
    try {
      const result = await api.listExtractionJobs(file.id);
      setJobs(result.jobs);
    } catch {
      setJobs([]);
    }
  }, []);

  const refreshJob = useCallback(async (jobId: number) => {
    const result = await api.getExtractionJob(jobId);
    setJob(result.job);
    return result.job;
  }, []);

  useEffect(() => { void loadFiles(); }, [loadFiles]);

  useEffect(() => registerToolNav('json-extractor', selectedFile || job
    ? () => {
        if (job) setJob(null);
        else setSelectedFile(null);
      }
    : null), [selectedFile, job]);

  useEffect(() => {
    if (!job || !statusIsActive(job.status)) return;
    const timer = window.setInterval(() => {
      void refreshJob(job.id).catch(error => {
        console.error('[json-extractor] poll failed:', error);
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, refreshJob]);

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const result = await api.uploadExtractionFile(file);
      await loadFiles();
      await openFile(result.file);
    } catch (error: any) {
      toast.error(error?.message === 'pdf_text_layer_required'
        ? tr('This PDF has no text layer. OCR is required.', 'В PDF нет текстового слоя. Нужен OCR.')
        : error?.message || tr('Could not upload the document', 'Не удалось загрузить документ'));
    } finally {
      setUploading(false);
    }
  };

  const start = async () => {
    if (!selectedFile || !instruction.trim()) return;
    let example: Record<string, unknown>;
    try {
      const parsed = JSON.parse(exampleText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      example = parsed;
    } catch {
      toast.error(tr('The JSON example is invalid', 'В примере невалидный JSON'));
      return;
    }
    try {
      const result = await api.createExtractionJob({
        file_id: selectedFile.id,
        instruction: instruction.trim(),
        example,
        start_page: startPage,
        end_page: endPage,
        auto_confirm: autoConfirm,
      });
      setJob(result.job);
      const list = await api.listExtractionJobs(selectedFile.id);
      setJobs(list.jobs);
    } catch (error: any) {
      toast.error(error?.message || tr('Could not start extraction', 'Не удалось начать извлечение'));
    }
  };

  const removeFile = async (file: api.ExtractionFile) => {
    if (!window.confirm(tr(
      `Delete “${file.name}” and all extraction results?`,
      `Удалить «${file.name}» и все результаты извлечения?`,
    ))) return;
    await api.deleteExtractionFile(file.id);
    if (selectedFile?.id === file.id) {
      setSelectedFile(null);
      setJob(null);
    }
    await loadFiles();
  };

  const renameFile = async (file: api.ExtractionFile) => {
    const name = window.prompt(tr('Document name', 'Название документа'), file.name)?.trim();
    if (!name || name === file.name) return;
    await api.renameExtractionFile(file.id, name);
    await loadFiles();
  };

  const updateItem = async (
    item: api.ExtractionItem,
    input: { data?: Record<string, unknown>; status?: 'review' | 'confirmed' },
  ) => {
    if (!job) return;
    await api.updateExtractionItem(job.id, item.id, input);
    await refreshJob(job.id);
  };

  const saveEdit = async (item: api.ExtractionItem) => {
    try {
      const parsed = JSON.parse(editText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      await updateItem(item, { data: parsed });
      setEditingId(null);
    } catch {
      toast.error(tr('The card must contain a JSON object', 'Карточка должна содержать JSON-объект'));
    }
  };

  const confirmed = useMemo(
    () => job?.items.filter(item => item.status === 'confirmed') || [],
    [job?.items],
  );
  const reviewCount = job?.items.filter(item => item.status === 'review').length || 0;
  const finalJson = useMemo(
    () => JSON.stringify(confirmed.map(item => item.data), null, 2),
    [confirmed],
  );

  const copyFinal = async () => {
    await navigator.clipboard.writeText(finalJson);
    toast.success(tr('JSON copied', 'JSON скопирован'));
  };

  const downloadFinal = () => {
    if (!selectedFile) return;
    const blob = new Blob([finalJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedFile.name.replace(/\.[^.]+$/, '') || 'extracted'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!selectedFile) {
    return (
      <div className={s.root}>
        <div className={s.toolbar}>
          <button className={s.primary} onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? tr('Processing…', 'Обработка…') : tr('Upload document', 'Загрузить документ')}
          </button>
          <input
            ref={inputRef}
            className={s.hidden}
            type="file"
            accept=".pdf,.docx,.txt,.md,.json,.csv,.xlsx,.xml,.yaml,.yml"
            onChange={upload}
          />
        </div>
        <div className={s.scroll}>
          {loading && <div className={s.empty}>{tr('Loading…', 'Загрузка…')}</div>}
          {!loading && files.length === 0 && (
            <div className={s.empty}>
              <strong>{tr('Turn a document into JSON', 'Превратить документ в JSON')}</strong>
              <span>{tr(
                'Upload a document, describe what to extract, and review the result.',
                'Загрузите документ, опишите что извлечь и проверьте результат.',
              )}</span>
            </div>
          )}
          {files.map(file => (
            <div key={file.id} className={s.fileCard} onClick={() => void openFile(file)}>
              <div className={s.fileIcon}>JSON</div>
              <div className={s.fileInfo}>
                <strong>{file.name}</strong>
                <span>
                  {file.page_count} {tr('pages', 'стр.')} · {formatNumber(file.char_count)} {tr('chars', 'симв.')}
                </span>
                {file.latest_job && <small>{statusLabel(file.latest_job.status)}</small>}
              </div>
              <details className={s.menu} onClick={event => event.stopPropagation()}>
                <summary>•••</summary>
                <div>
                  <button onClick={() => void openFile(file)}>{tr('Open', 'Открыть')}</button>
                  <button onClick={() => void renameFile(file)}>{tr('Rename', 'Переименовать')}</button>
                  <button className={s.danger} onClick={() => void removeFile(file)}>{tr('Delete', 'Удалить')}</button>
                </div>
              </details>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className={s.root}>
        <div className={s.documentHeader}>
          <button className={s.iconButton} onClick={() => setSelectedFile(null)}>‹</button>
          <div>
            <strong>{selectedFile.name}</strong>
            <span>
              {selectedFile.page_count} {tr('pages', 'стр.')} · {formatNumber(selectedFile.char_count)} {tr('chars', 'симв.')} · ≈{formatNumber(selectedFile.approximate_tokens)} {tr('tokens', 'токенов')}
            </span>
          </div>
          <button className={s.iconButton} onClick={() => void renameFile(selectedFile)}>✎</button>
          <button className={s.iconButton} onClick={() => void removeFile(selectedFile)}>×</button>
        </div>
        <div className={s.form}>
          <label>
            <span>{tr('What should be extracted?', 'Что нужно извлечь?')}</span>
            <textarea
              value={instruction}
              onChange={event => setInstruction(event.target.value)}
              placeholder={tr(
                'Extract spells: name, type and description',
                'Извлеки заклинания: название, тип и описание',
              )}
            />
          </label>
          <label>
            <span>{tr('Example JSON object', 'Пример JSON-объекта')}</span>
            <textarea className={s.code} value={exampleText} onChange={event => setExampleText(event.target.value)} />
          </label>
          <div className={s.range}>
            <label>
              <span>{tr('From page', 'Со страницы')}</span>
              <input type="number" min={1} max={selectedFile.page_count} value={startPage}
                onChange={event => setStartPage(Number(event.target.value))} />
            </label>
            <label>
              <span>{tr('To page', 'До страницы')}</span>
              <input type="number" min={1} max={selectedFile.page_count} value={endPage}
                onChange={event => setEndPage(Number(event.target.value))} />
            </label>
          </div>
          <label className={s.toggleRow}>
            <input type="checkbox" checked={autoConfirm} onChange={event => setAutoConfirm(event.target.checked)} />
            <span>
              <strong>{tr('Add completed objects directly to final JSON', 'Сразу добавлять готовые объекты в итоговый JSON')}</strong>
              <small>{tr(
                'Incomplete objects will still wait for the next pages.',
                'Незавершённые объекты всё равно дождутся следующих страниц.',
              )}</small>
            </span>
          </label>
          <button className={s.primary} disabled={!instruction.trim()} onClick={() => void start()}>
            {tr('Start extraction', 'Начать извлечение')}
          </button>
          {jobs.length > 0 && (
            <section className={s.previous}>
              <h3>{tr('Previous runs', 'Прошлые запуски')}</h3>
              {jobs.map(item => (
                <button key={item.id} onClick={() => void refreshJob(item.id)}>
                  <span>#{item.id} · {item.start_page}–{item.end_page}</span>
                  <small>{statusLabel(item.status)}</small>
                </button>
              ))}
            </section>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.jobHeader}>
        <button className={s.iconButton} onClick={() => setJob(null)}>‹</button>
        <div>
          <strong>{selectedFile.name}</strong>
          <span>{job.processed_batches}/{job.total_batches} {tr('batches', 'пакетов')}</span>
        </div>
        <span className={`${s.status} ${s[job.status] || ''}`}>{statusLabel(job.status)}</span>
      </div>
      <div className={s.progress}><i style={{ width: `${job.total_batches ? job.processed_batches / job.total_batches * 100 : 0}%` }} /></div>
      {job.error && <div className={s.error}>{job.error}</div>}
      <div className={s.jobActions}>
        {reviewCount > 0 && (
          <button className={s.primary} onClick={async () => {
            await api.confirmExtractionItems(job.id);
            await refreshJob(job.id);
          }}>{tr(`Confirm all (${reviewCount})`, `Подтвердить все (${reviewCount})`)}</button>
        )}
        <button onClick={copyFinal}>{tr('Copy JSON', 'Копировать JSON')}</button>
        <button onClick={downloadFinal}>{tr('Download', 'Скачать')}</button>
      </div>
      <div className={s.items}>
        {job.items.length === 0 && (
          <div className={s.empty}>{statusIsActive(job.status)
            ? tr('The first cards will appear here.', 'Здесь появятся первые карточки.')
            : tr('No objects found.', 'Объекты не найдены.')}</div>
        )}
        {job.items.map(item => (
          <article key={item.id} className={`${s.item} ${s[item.status]}`}>
            <header>
              <span>{statusLabel(item.status)}</span>
              <small>{tr('pages', 'стр.')} {item.source_pages.join(', ')}</small>
            </header>
            {editingId === item.id ? (
              <textarea className={s.code} value={editText} onChange={event => setEditText(event.target.value)} />
            ) : (
              <pre>{JSON.stringify(item.data, null, 2)}</pre>
            )}
            <footer>
              {editingId === item.id ? (
                <>
                  <button className={s.primary} onClick={() => void saveEdit(item)}>{tr('Save', 'Сохранить')}</button>
                  <button onClick={() => setEditingId(null)}>{tr('Cancel', 'Отмена')}</button>
                </>
              ) : (
                <>
                  {item.status === 'review' && (
                    <button className={s.primary} onClick={() => void updateItem(item, { status: 'confirmed' })}>
                      {tr('Confirm', 'Подтвердить')}
                    </button>
                  )}
                  <button onClick={() => {
                    setEditingId(item.id);
                    setEditText(JSON.stringify(item.data, null, 2));
                  }}>{tr('Edit', 'Изменить')}</button>
                  <button className={s.danger} onClick={async () => {
                    await api.deleteExtractionItem(job.id, item.id);
                    await refreshJob(job.id);
                  }}>{tr('Delete', 'Удалить')}</button>
                </>
              )}
            </footer>
          </article>
        ))}
        <section className={s.final}>
          <header>
            <strong>{tr('Final JSON', 'Итоговый JSON')}</strong>
            <span>{confirmed.length}</span>
          </header>
          <pre>{finalJson}</pre>
        </section>
      </div>
    </div>
  );
}
