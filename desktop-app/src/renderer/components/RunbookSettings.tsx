import { useTranslation } from 'react-i18next';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'framer-motion';
import * as api from '../lib/api';
import { normalizeSettingsSearch } from '../lib/settings-navigation';
import { RUNBOOK_COMMAND_TOOLS_ENABLED } from '../lib/runbook-ui';
import { Icon } from './Icon';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ConfirmDialog } from './ConfirmDialog';
import shared from './SettingsModal.module.scss';
import catalog from './MacroSettings.module.scss';
import s from './RunbookSettings.module.scss';

type Runbook = {
  id: number; title: string; content: string; commands: string[];
  created_at: number; updated_at: number;
  author_user_id?: number; author_name?: string;
};
type Tab = 'personal' | 'public';
type Draft = Pick<Runbook, 'title' | 'content' | 'commands'>;
const emptyDraft = (): Draft => ({ title: '', content: '', commands: [''] });
const endpoint = (tab: Tab) => `/api/v1/devops/runbooks${tab === 'public' ? '/public' : ''}`;

export function RunbookSettings({ isAdmin = 0 }: { isAdmin?: number }) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>('personal');
  const [lists, setLists] = useState<Record<Tab, Runbook[]>>({ personal: [], public: [] });
  const [loading, setLoading] = useState<Record<Tab, boolean>>({ personal: true, public: true });
  const [failed, setFailed] = useState<Record<Tab, boolean>>({ personal: false, public: false });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'read' | 'edit' | 'new'>('read');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseDraft, setBaseDraft] = useState<Draft>(emptyDraft);
  const [preview, setPreview] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'publish' | null>(null);
  const [review, setReview] = useState<{ tab: Tab; id: number; text: string } | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const list = lists[tab];
  const selected = list.find(item => item.id === selectedId) ?? list[0];
  const editing = view !== 'read';
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(baseDraft);
  const canEdit = tab === 'personal' || isAdmin === 1;
  const copy = (key: string) => t(`advanced.runbook.library.${key}`);
  const load = useCallback(async (target: Tab) => {
    setLoading(value => ({ ...value, [target]: true }));
    setFailed(value => ({ ...value, [target]: false }));
    try {
      const result = await api.apiFetch<{ runbooks: Runbook[] }>(endpoint(target));
      setLists(value => ({ ...value, [target]: result.runbooks }));
    } catch { setFailed(value => ({ ...value, [target]: true })); }
    finally { setLoading(value => ({ ...value, [target]: false })); }
  }, []);
  useEffect(() => { void load('personal'); void load('public'); }, [load]);
  useEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selected?.id, tab, view]);
  const visible = useMemo(() => {
    const words = normalizeSettingsSearch(query).split(' ').filter(Boolean);
    return list.filter(item => words.every(word => normalizeSettingsSearch(`${item.title} ${item.content} ${item.author_name || ''}`).includes(word)));
  }, [list, query]);
  const request = (action: () => void) => { if (busy) return; if (dirty) setPending(() => action); else action(); };
  const changeTab = (target: Tab) => request(() => { setTab(target); setView('read'); setSelectedId(null); setQuery(''); });
  const create = () => request(() => { const value = emptyDraft(); setTab('personal'); setQuery(''); setDraft(value); setBaseDraft(value); setPreview(false); setView('new'); });
  const edit = () => {
    if (!selected || !canEdit || busy) return;
    const value = { title: selected.title, content: selected.content, commands: selected.commands.length ? [...selected.commands] : [''] };
    setDraft(value); setBaseDraft(value); setPreview(false); setView('edit');
  };
  const save = async () => {
    if (busy || !dirty || !draft.title.trim() || !draft.content.trim() || !canEdit) return;
    setBusy('save');
    const value = { title: draft.title.trim(), content: draft.content.trim() };
    // Omit hidden commands on PUT so existing data (including concurrent changes) stays intact.
    const commandUpdate = RUNBOOK_COMMAND_TOOLS_ENABLED ? { commands: draft.commands.map(command => command.trim()).filter(Boolean) } : {};
    try {
      const now = Math.floor(Date.now() / 1000);
      if (view === 'edit' && selected) {
        await api.apiFetch(`${endpoint(tab)}/${selected.id}`, { method: 'PUT', body: JSON.stringify({ ...value, ...commandUpdate }) });
        setLists(current => ({ ...current, [tab]: current[tab].map(item => item.id === selected.id ? { ...item, ...value, ...commandUpdate, updated_at: now } : item) }));
        setSelectedId(selected.id);
      } else {
        const result = await api.apiFetch<{ id: number }>(endpoint('personal'), { method: 'POST', body: JSON.stringify({ ...value, ...commandUpdate }) });
        const item: Runbook = { ...value, commands: [], ...commandUpdate, id: result.id, created_at: now, updated_at: now };
        setLists(current => ({ ...current, personal: [item, ...current.personal] })); setSelectedId(result.id);
      }
      setQuery(''); setView('read'); setReview(null); toast.success(t(view === 'new' ? 'advanced.runbook.created' : 'advanced.runbook.updated'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.common.saveFailed'))); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!selected || busy || !canEdit) return;
    setBusy('delete');
    try {
      await api.apiFetch(`${endpoint(tab)}/${selected.id}`, { method: 'DELETE' });
      setLists(current => ({ ...current, [tab]: current[tab].filter(item => item.id !== selected.id) }));
      setSelectedId(null); setConfirm(null); toast.success(t('advanced.runbook.deleted'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.common.deleteFailed'))); }
    finally { setBusy(null); }
  };
  const publish = async () => {
    if (!selected || tab !== 'personal' || isAdmin !== 1 || busy) return;
    setBusy('publish');
    try {
      const result = await api.apiFetch<{ id: number }>(endpoint('public'), { method: 'POST', body: JSON.stringify({ title: selected.title, content: selected.content, commands: selected.commands }) });
      setLists(current => ({ ...current, public: [{ ...selected, id: result.id }, ...current.public] }));
      setConfirm(null); toast.success(t('advanced.runbook.published'));
      void load('public');
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.runbook.publishFailed'))); }
    finally { setBusy(null); }
  };
  const saveToMine = async () => {
    if (!selected || tab !== 'public' || busy) return;
    setBusy('copy');
    try {
      const result = await api.apiFetch<{ id: number }>(`${endpoint('public')}/${selected.id}/save`, { method: 'POST' });
      const now = Math.floor(Date.now() / 1000);
      setLists(current => ({ ...current, personal: [{ ...selected, author_name: undefined, author_user_id: undefined, id: result.id, created_at: now, updated_at: now }, ...current.personal] }));
      setTab('personal'); setQuery(''); setSelectedId(result.id); toast.success(t('advanced.runbook.savedToMine'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.common.saveFailed'))); }
    finally { setBusy(null); }
  };
  // Temporarily hidden command tools. Data and endpoints remain compatible.
  const extractCommands = async () => {
    if (!draft.content.trim() || busy) return;
    setBusy('extract');
    try {
      const result = await api.apiFetch<{ commands: string[] }>('/api/v1/devops/runbooks/extract-commands', { method: 'POST', body: JSON.stringify({ content: draft.content }) });
      if (result.commands.length) setDraft(current => ({ ...current, commands: result.commands }));
      else toast.info(t('advanced.runbook.noCommandsFound'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.runbook.extractFailed'))); }
    finally { setBusy(null); }
  };
  const reviewCommands = async () => {
    if (!selected?.commands.length || busy) return;
    setBusy('review');
    try {
      const result = await api.apiFetch<{ verdict: string }>('/api/v1/devops/runbooks/review-commands', { method: 'POST', body: JSON.stringify({ commands: selected.commands }) });
      setReview({ tab, id: selected.id, text: result.verdict });
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.runbook.reviewFailed'))); }
    finally { setBusy(null); }
  };
  const date = (timestamp: number) => new Date(timestamp * 1000).toLocaleDateString(i18n.language);
  return <div className={`${shared.panel} ${s.panel}`}>
    <div className={shared.panelTitle}>{t('settings.sections.runbooks')}</div>
    <p className={s.intro}>{copy('intro')}</p>
    <div className={s.help}>
      <button type="button" className={s.helpToggle} aria-expanded={showHelp} aria-controls="runbook-help" onClick={() => setShowHelp(value => !value)}>
        <span>{copy('howTo')}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transition: 'transform 0.15s', transform: showHelp ? 'rotate(180deg)' : 'none' }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <AnimatePresence initial={false}>
        {showHelp && <motion.div id="runbook-help"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto', transition: { duration: 0.2, ease: 'easeOut' } }}
          exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
          style={{ overflow: 'hidden' }}>
          <p>{copy('howToBody')}</p><blockquote>{copy('example')}</blockquote>
        </motion.div>}
      </AnimatePresence>
    </div>
    {loading[tab] ? <div role="status">{t('common.loading')}</div> : <div className={catalog.workspace}>
      <aside className={catalog.catalog} aria-label={copy('list')}>
        <div className={s.tabs}>{(['personal', 'public'] as const).map(value => <button type="button" key={value} disabled={Boolean(busy)} aria-pressed={tab === value} onClick={() => changeTab(value)}>{t(`advanced.runbook.${value === 'personal' ? 'mine' : 'public'}`)}</button>)}</div>
        <input type="search" className={shared.fieldInput} placeholder={copy('search')} aria-label={copy('search')} value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className={shared.saveBtn} disabled={Boolean(busy)} onClick={create}>+ {copy('create')}</button>
        <div className={catalog.list}>
          {loading[tab] ? <p role="status" className={catalog.empty}>{t('common.loading')}</p> : failed[tab] ? <div className={catalog.empty}><p>{copy('loadFailed')}</p><button type="button" className={shared.cancelBtn} onClick={() => void load(tab)}>{copy('retry')}</button></div> : visible.map(item => <button type="button" key={item.id} disabled={Boolean(busy)} className={`${catalog.item} ${selected?.id === item.id && view !== 'new' ? catalog.active : ''}`} aria-pressed={selected?.id === item.id && view !== 'new'} onClick={() => request(() => { setSelectedId(item.id); setView('read'); })}>
            <Icon name="book" size={17} /><span><strong title={item.title}>{item.title}</strong><span className={catalog.meta}>{tab === 'public' && item.author_name ? item.author_name : date(item.updated_at)}</span></span>
          </button>)}
          {!loading[tab] && !failed[tab] && !visible.length && <p className={catalog.empty}>{query ? t('common.nothingFound') : copy(tab === 'public' ? 'emptyPublic' : 'emptyMine')}</p>}
        </div>
        {!loading[tab] && !failed[tab] && <span className={catalog.count}>{visible.length} / {list.length}</span>}
      </aside>
      <div className={catalog.detail} ref={detailRef}>
        {editing ? <>
          <h3 className={catalog.title}>{copy(view === 'new' ? 'create' : 'edit')}</h3>
          {tab === 'public' && <p className={s.hint}>{copy('editingPublic')}</p>}
          <fieldset className={s.editor} disabled={Boolean(busy)}>
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.common.name')}</span><input className={shared.fieldInput} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder={copy('titlePlaceholder')} /></label>
            <div className={s.toolbar}><span className={shared.fieldLabel}>{t('advanced.runbook.text')}</span><div className={s.modes}>{[false, true].map(value => <button type="button" key={String(value)} aria-pressed={preview === value} onClick={() => setPreview(value)}>{copy(value ? 'preview' : 'write')}</button>)}</div></div>
            {preview ? <div className={`${s.document} ${s.preview}`}>{draft.content.trim() ? <MarkdownRenderer content={draft.content} /> : <p className={s.hint}>{copy('previewEmpty')}</p>}</div> : <textarea aria-label={t('advanced.runbook.markdownText')} className={`${shared.textareaInput} ${s.body}`} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} placeholder={copy('contentPlaceholder')} />}
            <p className={s.hint}>{copy('editorHelp')}</p>
            {RUNBOOK_COMMAND_TOOLS_ENABLED && <div className={shared.fieldGroup}>
              <span className={shared.fieldLabel}>{t('advanced.common.commands')}</span>
              <button type="button" className={shared.cancelBtn} disabled={!draft.content.trim()} onClick={() => void extractCommands()}>{t('advanced.runbook.extract')}</button>
              {draft.commands.map((command, index) => <div className={shared.commandRow} key={index}><input aria-label={t('advanced.common.commandNumber', { number: index + 1 })} className={shared.fieldInput} value={command} onChange={event => setDraft({ ...draft, commands: draft.commands.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className={shared.removeCmdBtn} disabled={draft.commands.length === 1} onClick={() => setDraft({ ...draft, commands: draft.commands.filter((_, i) => i !== index) })}>×</button></div>)}
              <button type="button" className={shared.addCmdBtn} onClick={() => setDraft({ ...draft, commands: [...draft.commands, ''] })}>{t('advanced.common.addCommand')}</button>
            </div>}
          </fieldset>
          <div className={catalog.actions}><button type="button" className={shared.saveBtn} disabled={Boolean(busy) || !dirty || !draft.title.trim() || !draft.content.trim()} onClick={() => void save()}>{busy === 'save' ? t('common.saving') : t('common.save')}</button><button type="button" className={shared.cancelBtn} disabled={Boolean(busy)} onClick={() => request(() => setView('read'))}>{t('common.cancel')}</button></div>
        </> : loading[tab] || failed[tab] ? <div className={catalog.emptyDetail}>{copy(loading[tab] ? 'loading' : 'loadFailed')}</div> : selected ? <>
          <h3 className={catalog.title}>{selected.title}</h3>
          <div className={s.source}>{tab === 'public' && <span>{copy('publicSource')}{selected.author_name ? ` · ${selected.author_name}` : ''}</span>}<span>{copy('updated')} {date(selected.updated_at)}</span></div>
          <div className={catalog.actions}>{tab === 'public' && <button type="button" className={shared.saveBtn} disabled={Boolean(busy)} onClick={() => void saveToMine()}>{busy === 'copy' ? t('common.saving') : t('advanced.runbook.saveToMine')}</button>}{canEdit && <button type="button" className={shared.cancelBtn} disabled={Boolean(busy)} onClick={edit}>{t('common.edit')}</button>}</div>
          {tab === 'public' && <p className={s.hint}>{copy('publicHelp')}</p>}
          <div className={s.document}><MarkdownRenderer content={selected.content} /></div>
          {RUNBOOK_COMMAND_TOOLS_ENABLED && selected.commands.length > 0 && <section><ol className={catalog.commands}>{selected.commands.map((command, index) => <li key={index}><pre>{command}</pre></li>)}</ol><button type="button" className={shared.cancelBtn} disabled={Boolean(busy)} onClick={() => void reviewCommands()}>{t('advanced.runbook.askSafety')}</button>{review?.tab === tab && review.id === selected.id && <MarkdownRenderer content={review.text} />}</section>}
          {canEdit && <div className={s.footer}>{tab === 'personal' && isAdmin === 1 && <button type="button" disabled={Boolean(busy)} onClick={() => setConfirm('publish')}>{t('advanced.runbook.publishForAll')}</button>}<button type="button" className={s.danger} disabled={Boolean(busy)} onClick={() => setConfirm('delete')}>{t('common.delete')}</button></div>}
        </> : <div className={catalog.emptyDetail}><Icon name="book" size={28} /><h3>{copy(tab === 'public' ? 'emptyPublic' : 'emptyTitle')}</h3><p>{copy(tab === 'public' ? 'publicHelp' : 'emptyHelp')}</p></div>}
      </div>
    </div>}
    {pending && <ConfirmDialog open title={copy('discardTitle')} text={copy('discardHelp')} confirmLabel={copy('discard')} confirmTone="primary" onCancel={() => setPending(null)} onConfirm={() => { const action = pending; setPending(null); action(); }} />}
    {confirm && <ConfirmDialog open title={copy(confirm === 'publish' ? 'publishTitle' : 'deleteTitle')} text={copy(confirm === 'publish' ? 'publishHelp' : tab === 'public' ? 'deletePublicHelp' : 'deleteHelp')} confirmLabel={confirm === 'publish' ? t('advanced.runbook.publishForAll') : t('common.delete')} confirmTone={confirm === 'publish' ? 'primary' : 'danger'} confirmDisabled={Boolean(busy)} onCancel={() => { if (!busy) setConfirm(null); }} onConfirm={() => void (confirm === 'publish' ? publish() : remove())} />}
  </div>;
}
