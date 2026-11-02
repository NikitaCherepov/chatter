import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { normalizeSettingsSearch } from '../lib/settings-navigation';
import { Select } from './Select';
import { Icon } from './Icon';
import { ConfirmDialog } from './ConfirmDialog';
import { MarkdownRenderer } from './MarkdownRenderer';
import shared from './SettingsModal.module.scss';
import toggle from './MemoryPopover.module.scss';
import s from './MacroSettings.module.scss';

export type Macro = { id: number; title: string; description: string; commands: string[]; enabled: boolean; pinned: boolean; return_output: boolean };
type Draft = Omit<Macro, 'id'>;
const emptyDraft = (): Draft => ({ title: '', description: '', commands: [''], enabled: true, pinned: false, return_output: false });
type Props = { onChange?: (macros: Macro[]) => void };
export function MacroSettings({ onChange }: Props) {
  const { t } = useTranslation();
  const detailRef = useRef<HTMLDivElement>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'pinned' | 'disabled'>('all');
  const [view, setView] = useState<'read' | 'edit' | 'new'>('read');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseDraft, setBaseDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [deleting, setDeleting] = useState<Macro | null>(null);
  const [explanation, setExplanation] = useState<{ id: number; text: string } | null>(null);
  const [output, setOutput] = useState<{ id: number; text: string } | null>(null);
  const selected = macros.find(macro => macro.id === selectedId);
  useEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selectedId, view]);
  const editing = view !== 'read';
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(baseDraft);
  const commands = draft.commands.map(command => command.trim()).filter(Boolean);
  const commit = (next: Macro[]) => { setMacros(next); onChange?.(next); };
  const load = useCallback(async () => {
    setLoading(true); setLoadFailed(false);
    try {
      const result = await api.apiFetch<{ macros: Macro[] }>('/api/v1/macros');
      setMacros(result.macros); onChange?.(result.macros);
      setSelectedId(current => result.macros.some(macro => macro.id === current) ? current : result.macros[0]?.id ?? null);
    } catch { setLoadFailed(true); }
    finally { setLoading(false); }
  }, [onChange]);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => {
    const tokens = normalizeSettingsSearch(query).split(' ').filter(Boolean);
    return macros.filter(macro => (filter === 'all' || (filter === 'pinned' ? macro.pinned : !macro.enabled))
      && tokens.every(token => normalizeSettingsSearch(`${macro.title} ${macro.description} ${macro.commands.join(' ')}`).includes(token)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id - b.id);
  }, [macros, query, filter]);
  const request = (action: () => void) => { if (busy) return; if (dirty) setPending(() => action); else action(); };
  const newMacro = () => request(() => { const value = emptyDraft(); setDraft(value); setBaseDraft(value); setView('new'); });
  const select = (id: number) => request(() => { setSelectedId(id); setView('read'); });
  const edit = () => { if (!selected) return; const { id: _id, ...value } = selected; setDraft({ ...value, commands: [...value.commands] }); setBaseDraft(value); setView('edit'); };
  const save = async () => {
    if (busy || !dirty || !commands.length) return;
    setBusy('save');
    const value = { ...draft, title: draft.title.trim() || t('advanced.macros.catalog.defaultName', { number: macros.length + 1 }), description: draft.description.trim(), commands };
    try {
      if (view === 'edit' && selected) {
        await api.apiFetch(`/api/v1/macros/${selected.id}`, { method: 'PUT', body: JSON.stringify(value) });
        commit(macros.map(macro => macro.id === selected.id ? { ...value, id: selected.id } : macro));
        if (JSON.stringify(selected.commands) !== JSON.stringify(value.commands)) setExplanation(null);
      } else {
        const result = await api.apiFetch<{ id: number }>('/api/v1/macros', { method: 'POST', body: JSON.stringify(value) });
        commit([...macros, { ...value, id: result.id }]); setSelectedId(result.id); setQuery(''); setFilter('all');
      }
      setView('read'); toast.success(t(view === 'new' ? 'advanced.macros.created' : 'advanced.macros.updated'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.macros.saveFailed'))); }
    finally { setBusy(null); }
  };
  const patch = async (key: 'enabled' | 'pinned') => {
    if (!selected || busy) return;
    const previous = macros;
    const value = !selected[key];
    commit(macros.map(macro => macro.id === selected.id ? { ...macro, [key]: value } : macro)); setBusy('patch');
    try { await api.apiFetch(`/api/v1/macros/${selected.id}`, { method: 'PUT', body: JSON.stringify({ [key]: value }) }); }
    catch { commit(previous); toast.error(t('advanced.common.error')); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy('delete');
    try {
      await api.apiFetch(`/api/v1/macros/${deleting.id}`, { method: 'DELETE' });
      const next = macros.filter(macro => macro.id !== deleting.id); commit(next);
      setSelectedId(next[0]?.id ?? null); setView('read'); setDeleting(null);
    } catch { toast.error(t('advanced.common.deleteFailed')); }
    finally { setBusy(null); }
  };
  const explain = async () => {
    if (!selected || busy) return;
    setBusy('explain');
    try {
      const result = await api.apiFetch<{ explanation: string }>('/api/v1/macro/explain', { method: 'POST', body: JSON.stringify({ commands: selected.commands }) });
      setExplanation({ id: selected.id, text: result.explanation });
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.macros.explainFailed'))); }
    finally { setBusy(null); }
  };
  const describe = async () => {
    if (!commands.length || busy) return;
    setBusy('describe');
    try {
      const result = await api.apiFetch<{ title: string; description: string }>('/api/v1/macro/describe', { method: 'POST', body: JSON.stringify({ commands, current_title: draft.title, current_description: draft.description }) });
      setDraft(value => ({ ...value, title: result.title || value.title, description: result.description || value.description }));
      toast.success(t('advanced.macros.catalog.suggestionReady'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.macros.descriptionFailed'))); }
    finally { setBusy(null); }
  };
  const execute = async () => {
    if (!selected || busy) return;
    if (!window.electronAPI?.executeCommands) { toast.error(t('advanced.macros.executionUnavailable')); return; }
    setBusy('execute');
    try {
      const result = await window.electronAPI.executeCommands(selected.commands);
      setOutput({ id: selected.id, text: result }); toast.success(t('advanced.macros.executed'));
    } catch (error) { toast.error(api.getApiErrorMessage(error, t('advanced.macros.executionFailed'))); }
    finally { setBusy(null); }
  };
  const switchRow = (key: 'enabled' | 'pinned', label: string, hint: string) => {
    const checked = editing ? draft[key] : Boolean(selected?.[key]);
    return <div className={s.option} key={key}><div><span>{label}</span><p>{hint}</p></div>
      <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={Boolean(busy)}
        className={`${toggle.toggle} ${checked ? toggle.toggleActive : ''}`}
        onClick={() => editing ? setDraft(value => ({ ...value, [key]: !value[key] })) : void patch(key)}><span /></button>
    </div>;
  };
  return <div className={`${shared.panel} ${s.panel}`}>
    <div className={shared.panelTitle}>{t('settings.sections.macros')}</div>
    <p className={s.intro}>{t('advanced.macros.catalog.help')}</p>
    {loading ? <div role="status">{t('common.loading')}</div> : loadFailed ? <div className={s.empty}><p>{t('advanced.macros.catalog.loadFailed')}</p><button type="button" className={shared.cancelBtn} onClick={() => void load()}>{t('advanced.macros.catalog.retry')}</button></div> :
    <div className={s.workspace}>
      <aside className={s.catalog} aria-label={t('advanced.macros.catalog.list')}>
        <input type="search" className={shared.fieldInput} placeholder={t('advanced.macros.catalog.search')} aria-label={t('advanced.macros.catalog.search')} value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className={shared.saveBtn} disabled={Boolean(busy)} onClick={newMacro}>+ {t('advanced.macros.create')}</button>
        <div className={s.filters}>{(['all', 'pinned', 'disabled'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`advanced.macros.catalog.${value}`)}</button>)}</div>
        <div className={s.list}>
          {visible.map(macro => <button type="button" key={macro.id} disabled={Boolean(busy)} aria-pressed={selectedId === macro.id && view !== 'new'} onClick={() => select(macro.id)} className={`${s.item} ${selectedId === macro.id && view !== 'new' ? s.active : ''}`}>
            <Icon name="terminal" size={17} /><span><strong>{macro.title}</strong>{macro.description && <small>{macro.description}</small>}<span className={s.meta}>{t('advanced.macros.catalog.commandCount', { count: macro.commands.length })}{macro.pinned && ` · ${t('advanced.macros.catalog.pinnedState')}`}{!macro.enabled && ` · ${t('advanced.macros.catalog.disabledState')}`}</span></span>
          </button>)}
          {!visible.length && <p className={s.empty}>{t('common.nothingFound')}</p>}
        </div>
        <span className={s.count}>{visible.length} / {macros.length}</span>
      </aside>
      <div className={s.detail} ref={detailRef}>
        {editing ? <>
          <h3 className={s.title}>{t(view === 'new' ? 'advanced.macros.create' : 'advanced.macros.catalog.edit')}</h3>
          <fieldset className={s.editor} disabled={Boolean(busy)}>
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.common.name')}</span><input className={shared.fieldInput} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder={t('advanced.macros.namePlaceholder')} /></label>
            <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.common.description')}</span><textarea className={shared.textareaInput} rows={2} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder={t('advanced.macros.descriptionPlaceholder')} /></label>
            <div className={s.subhead}><span>{t('advanced.common.commands')}</span><span className={s.meta}>{t('advanced.macros.catalog.sequence')}</span></div>
            {draft.commands.map((command, index) => <div className={s.commandEdit} key={index}><span>{index + 1}</span><textarea className={shared.textareaInput} rows={2} aria-label={t('advanced.common.commandNumber', { number: index + 1 })} value={command} placeholder={t('advanced.common.commandNumberPlaceholder', { number: index + 1 })} onChange={event => setDraft({ ...draft, commands: draft.commands.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className={shared.removeCmdBtn} disabled={draft.commands.length === 1} title={t('advanced.common.deleteCommand')} aria-label={t('advanced.common.deleteCommand')} onClick={() => setDraft({ ...draft, commands: draft.commands.filter((_, i) => i !== index) })}>×</button></div>)}
            <button type="button" className={shared.addCmdBtn} onClick={() => setDraft({ ...draft, commands: [...draft.commands, ''] })}>{t('advanced.common.addCommand')}</button>
            <div className={s.options}>
              {switchRow('enabled', t('advanced.macros.catalog.available'), t('advanced.macros.catalog.availableHelp'))}
              {switchRow('pinned', t('advanced.macros.catalog.pinnedLabel'), t('advanced.macros.catalog.pinnedHelp'))}
              <label className={shared.fieldGroup}><span className={shared.fieldLabel}>{t('advanced.macros.executionMode')}</span><Select value={draft.return_output ? 'output' : 'execute'} onChange={value => setDraft({ ...draft, return_output: value === 'output' })} options={[{ value: 'execute', label: t('advanced.macros.execution'), hint: t('advanced.macros.fireAndForget') }, { value: 'output', label: t('advanced.macros.withOutput'), hint: t('advanced.macros.outputHint') }]} /></label>
            </div>
            <button type="button" className={shared.cancelBtn} disabled={!commands.length} onClick={() => void describe()}>{busy === 'describe' ? t('common.loading') : t('advanced.macros.improveDescription')}</button>
          </fieldset>
          <div className={s.actions}><button type="button" className={shared.saveBtn} disabled={Boolean(busy) || !dirty || !commands.length} onClick={() => void save()}>{busy === 'save' ? t('common.saving') : t(view === 'new' ? 'advanced.macros.create' : 'advanced.common.saveChanges')}</button><button type="button" className={shared.cancelBtn} disabled={Boolean(busy)} onClick={() => request(() => setView('read'))}>{t('common.cancel')}</button></div>
        </> : selected ? <>
          <h3 className={s.title}>{selected.title}</h3>
          {selected.description && <p className={s.description}>{selected.description}</p>}
          <div className={s.actions}><button type="button" className={shared.saveBtn} disabled={Boolean(busy)} onClick={() => void execute()}>{busy === 'execute' ? t('advanced.macros.catalog.running') : t('advanced.macros.runNow')}</button><button type="button" className={shared.cancelBtn} disabled={Boolean(busy)} onClick={edit}>{t('common.edit')}</button></div>
          <div className={s.options}>
            {switchRow('enabled', t('advanced.macros.catalog.available'), t('advanced.macros.catalog.availableHelp'))}
            {switchRow('pinned', t('advanced.macros.catalog.pinnedLabel'), t('advanced.macros.catalog.pinnedHelp'))}
          </div>
          <div className={s.subhead}><span>{t('advanced.common.commands')}</span><span className={s.meta}>{t('advanced.macros.executionMode')}: {t(selected.return_output ? 'advanced.macros.withOutput' : 'advanced.macros.execution')}</span></div>
          <ol className={s.commands}>{selected.commands.map((command, index) => <li key={index}><span>{index + 1}</span><pre>{command}</pre></li>)}</ol>
          <button type="button" className={shared.cancelBtn} disabled={Boolean(busy)} onClick={() => void explain()}>{busy === 'explain' ? t('common.loading') : t('advanced.macros.askAi')}</button>
          {explanation?.id === selected.id && <section className={s.result}><h4>{t('advanced.macros.aiExplanation')}</h4><MarkdownRenderer content={explanation.text} /></section>}
          {output?.id === selected.id && <section className={s.result}><h4>{t('advanced.macros.catalog.lastOutput')}</h4><pre>{output.text || t('advanced.macros.catalog.noOutput')}</pre></section>}
          <div className={s.delete}><button type="button" disabled={Boolean(busy)} onClick={() => setDeleting(selected)}>{t('common.delete')}</button></div>
        </> : <div className={s.emptyDetail}><Icon name="terminal" size={28} /><h3>{t('advanced.macros.catalog.emptyTitle')}</h3><p>{t('advanced.macros.catalog.emptyHelp')}</p></div>}
      </div>
    </div>}
    {pending && <ConfirmDialog open title={t('advanced.macros.catalog.discardTitle')} text={t('advanced.macros.catalog.discardHelp')} confirmLabel={t('advanced.macros.catalog.discard')} confirmTone="primary" onCancel={() => setPending(null)} onConfirm={() => { const action = pending; setPending(null); action(); }} />}
    {deleting && <ConfirmDialog open title={t('advanced.macros.catalog.deleteTitle', { name: deleting.title })} text={t('advanced.macros.catalog.deleteHelp')} confirmDisabled={Boolean(busy)} onCancel={() => { if (!busy) setDeleting(null); }} onConfirm={() => void remove()} />}
  </div>;
}
