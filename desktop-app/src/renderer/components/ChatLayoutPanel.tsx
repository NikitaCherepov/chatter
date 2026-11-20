import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import { Select } from './Select';
import { ConfirmDialog } from './ConfirmDialog';
import { ConfirmationCard } from './ConfirmationCard';
import {
  CHAT_LAYOUT_OPTIONS, CHAT_LAYOUT_SIDEBAR_WIDTH, DEFAULT_CHAT_LAYOUT, MAX_CHAT_LAYOUT_PROFILES,
  type ChatLayout, type ChatLayoutProfile, type ChatLayoutCommand,
} from '../lib/chat-layout-schema';
import type { ChatLayouts } from '../lib/chat-layout-service';
import s from './ChatLayoutPanel.module.scss';
import settings from './SettingsModal.module.scss';

export type ChatLayoutProposal = { proposal_id: string; profile: ChatLayoutProfile };

const templates = {
  classic: DEFAULT_CHAT_LAYOUT,
  reading: {
    ...DEFAULT_CHAT_LAYOUT, tools: 'header', column: 'reading',
    chatList: 'compact', headerDetails: 'minimal',
  },
  wide: {
    ...DEFAULT_CHAT_LAYOUT, chatSide: 'right', composer: 'docked', column: 'wide', messages: 'bubbles',
  },
} satisfies Record<string, ChatLayout>;

const fields = Object.keys(CHAT_LAYOUT_OPTIONS) as (keyof ChatLayout)[];
const standardId = '@standard';
const newId = '@new';

function sameLayout(first: ChatLayoutProfile, second: ChatLayoutProfile) {
  return first.name.trim() === second.name && first.sidebarWidth === second.sidebarWidth
    && fields.every(key => first[key] === second[key]);
}

function LayoutSample({ layout }: { layout: ChatLayout & { sidebarWidth?: number } }) {
  const width = layout.sidebarWidth ?? CHAT_LAYOUT_SIDEBAR_WIDTH.default;
  return (
    <div aria-hidden="true" className={s.sample}
      data-side={layout.chatSide} data-tools={layout.tools} data-composer={layout.composer}
      data-column={layout.column} data-list={layout.chatList} data-messages={layout.messages}
      data-header={layout.headerDetails}
      style={{ '--sample-side': `${width / 14}%` } as CSSProperties}>
      <div className={s.sampleList}><i /><i /><i /><i /><i /></div>
      <div className={s.sampleChat}>
        <div className={s.sampleHeader}><i /><i /><i /><b /></div>
        <div className={s.sampleThread}>
          <div className={s.sampleExchange}><i /><i /><i /></div>
          <div className={s.sampleExchange}><i /><i /></div>
          <div className={s.sampleInput}><i /><b /></div>
        </div>
      </div>
      <div className={s.sampleTools}><i /><i /><i /></div>
    </div>
  );
}

export function ChatLayoutPanel({
  layouts, initialDraft, onPreview,
}: {
  layouts: ChatLayouts;
  initialDraft?: ChatLayoutProfile;
  onPreview: (profile: ChatLayoutProfile) => void;
}) {
  const { t } = useTranslation();
  const { state, saving } = layouts;
  const nameId = useId();
  const widthId = useId();
  const [edited, setEdited] = useState<ChatLayoutProfile | undefined>(initialDraft);
  const [selection, setSelection] = useState<string>();
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const selected = selection ?? state?.activeId ?? standardId;
  const saved = state?.profiles.find(item => item.id === (edited?.id ?? selected));
  const draft = edited ?? saved;
  const atLimit = (state?.profiles.length ?? 0) >= MAX_CHAT_LAYOUT_PROFILES;

  function choose(value: string) {
    setSelection(value);
    setEdited(undefined);
    setError('');
  }

  function create(template: keyof typeof templates) {
    setSelection(newId);
    setEdited({
      ...templates[template], id: crypto.randomUUID(), revision: 0,
      name: t(`chatLayout.templates.${template}`), sidebarWidth: CHAT_LAYOUT_SIDEBAR_WIDTH.default,
    });
    setError('');
  }

  async function change(command: ChatLayoutCommand) {
    setError('');
    try {
      const next = await layouts.change(command);
      choose(command.action === 'save' ? command.profile.id : next.activeId ?? standardId);
      setDeleting(false);
    } catch {
      setError(t('chatLayout.failed'));
    }
  }

  if (!state) return layouts.failed
    ? <div className={s.section}>
        <p role="alert" className={s.error}>{t('chatLayout.loadFailed')}</p>
        <button type="button" className={settings.cancelBtn} onClick={() => void layouts.retry()}>{t('chatLayout.retry')}</button>
      </div>
    : <p className={s.hint} role="status">{t('chatLayout.loading')}</p>;

  const valid = Boolean(draft?.name.trim()) && Boolean(saved || !atLimit);
  const dirty = Boolean(edited && (!saved || !sameLayout(edited, saved)));
  const stale = Boolean(draft && (saved?.revision ?? 0) !== draft.revision);
  const active = draft ? draft.id === state.activeId : state.activeId === null;
  const profiles = [
    { value: standardId, label: t('chatLayout.standard') },
    ...state.profiles.map(item => ({
      value: item.id, label: item.name, hint: item.id === state.activeId ? t('chatLayout.active') : undefined,
    })),
    ...(draft && !saved ? [{ value: newId, label: t('chatLayout.draft') }] : []),
  ];

  return (
    <div className={s.section}>
      <div className={s.picker}>
        <Select options={profiles} value={draft ? saved?.id ?? newId : standardId}
          ariaLabel={t('chatLayout.profiles')} disabled={saving} onChange={choose} />
        <button type="button" className={settings.cancelBtn} disabled={saving || atLimit} onClick={() => create('classic')}>
          {t('chatLayout.newProfile')}
        </button>
      </div>
      {draft ? (
        <>
          <LayoutSample layout={draft} />
          <div className={s.editGrid}>
            <label className={s.field} htmlFor={nameId}>
              <span>{t('chatLayout.name')}</span>
              <input className={settings.fieldInput} id={nameId} value={draft.name} maxLength={80} disabled={saving}
                onChange={event => setEdited({ ...draft, name: event.target.value })} />
            </label>
            <label className={s.field} htmlFor={widthId}>
              <span>{t('chatLayout.width')} <output>{draft.sidebarWidth} px</output></span>
              <input id={widthId} type="range" min={CHAT_LAYOUT_SIDEBAR_WIDTH.min} max={CHAT_LAYOUT_SIDEBAR_WIDTH.max}
                value={draft.sidebarWidth} disabled={saving} onChange={event => setEdited({ ...draft, sidebarWidth: Number(event.target.value) })} />
            </label>
            {fields.map(key => (
              <fieldset key={key} className={s.field} disabled={saving}>
                <legend>{t(`chatLayout.fields.${key}`)}</legend>
                <div className={s.segments}>
                  {CHAT_LAYOUT_OPTIONS[key].map(value => (
                    <button type="button" key={value} aria-pressed={draft[key] === value}
                      onClick={() => setEdited({ ...draft, [key]: value })}>
                      {t(`chatLayout.options.${value}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </>
      ) : (
        <div className={s.templates}>
          {Object.entries(templates).map(([key, template]) => (
            <button type="button" className={s.template} key={key} disabled={saving || atLimit}
              onClick={() => create(key as keyof typeof templates)}>
              <LayoutSample layout={template} />
              <span>{t(`chatLayout.templates.${key}`)}</span>
            </button>
          ))}
        </div>
      )}
      <div className={s.actions}>
        {draft && (
          <button type="button" className={settings.cancelBtn} onClick={() => onPreview(draft)} disabled={!valid || stale || saving}>
            {t('chatLayout.preview')}
          </button>
        )}
        {draft && dirty && !active && (
          <button type="button" className={settings.cancelBtn} onClick={() => void change({ action: 'save', profile: draft, apply: false })}
            disabled={!valid || stale || saving}>{t('chatLayout.save')}</button>
        )}
        <button type="button" className={settings.saveBtn} disabled={saving || stale || (draft ? !valid || (active && !dirty) : active)}
          onClick={() => void change(draft && dirty
            ? { action: 'save', profile: draft, apply: true }
            : { action: 'activate', id: draft?.id ?? null, revision: state.revision })}>
          {t(dirty ? 'chatLayout.saveApply' : 'chatLayout.apply')}
        </button>
        {saved && (
          <button type="button" className={`${settings.cancelBtn} ${s.delete}`} disabled={saving}
            onClick={() => setDeleting(true)}>{t('common.delete')}</button>
        )}
      </div>
      {active && !dirty && <p className={s.hint} role="status">{t('chatLayout.active')}</p>}
      {(error || stale) && <p role="alert" className={s.error}>{error || t('chatLayout.stale')}</p>}
      {atLimit && !draft && <p className={s.hint}>{t('chatLayout.limit')}</p>}
      <AnimatePresence>
        {deleting && saved && (
          <ConfirmDialog open title={t('chatLayout.deleteTitle', { name: saved.name })}
            text={error || (active ? t('chatLayout.deleteActive') : undefined)} confirmDisabled={saving}
            onCancel={() => { setDeleting(false); setError(''); }}
            onConfirm={() => void change({ action: 'delete', id: saved.id, revision: state.revision })} />
        )}
      </AnimatePresence>
    </div>
  );
}

export function ChatLayoutConfirmation({ proposal, layouts, onPreview, onResolved }: {
  proposal: ChatLayoutProposal;
  layouts: ChatLayouts;
  onPreview: () => void;
  onResolved: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const { profile } = proposal;
  const active = profile.id === layouts.state?.activeId;
  const stale = (layouts.state?.profiles.find(item => item.id === profile.id)?.revision ?? 0) !== profile.revision;

  async function save(apply: boolean) {
    setError('');
    try {
      const variant = !apply && active ? { ...profile, id: crypto.randomUUID(), revision: 0 } : profile;
      await layouts.change({ action: 'save', profile: variant, apply });
      onResolved();
    } catch {
      setError(t('chatLayout.failed'));
    }
  }

  return (
    <ConfirmationCard id={proposal.proposal_id} title={t('chatLayout.proposal')} actions={
      <>
        <button type="button" className={settings.cancelBtn} onClick={onPreview} disabled={layouts.saving || stale || !layouts.state}>{t('chatLayout.preview')}</button>
        <button type="button" className={settings.cancelBtn} disabled={layouts.saving || stale || !layouts.state}
          onClick={() => void save(false)}>{t(active ? 'chatLayout.copy' : 'chatLayout.save')}</button>
        <button type="button" className={settings.saveBtn} disabled={layouts.saving || stale || !layouts.state}
          onClick={() => void save(true)}>{t('chatLayout.saveApply')}</button>
        <button type="button" className={settings.cancelBtn} disabled={layouts.saving}
          onClick={onResolved}>{t('chatLayout.dismiss')}</button>
      </>
    }>
      <div className={s.section}>
        <strong>{profile.name}</strong>
        <LayoutSample layout={profile} />
        {(error || (stale && layouts.state)) && <p role="alert" className={s.error}>{error || t('chatLayout.stale')}</p>}
      </div>
    </ConfirmationCard>
  );
}

export function ChatLayoutPreviewBar({ profile, layouts, onApply, onClose, fromSettings }: {
  profile: ChatLayoutProfile;
  layouts: ChatLayouts;
  onApply: () => void;
  onClose: () => void;
  fromSettings: boolean;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const bar = useRef<HTMLElement>(null);
  useEffect(() => { bar.current?.focus({ preventScroll: true }); }, []);
  const state = layouts.state;
  const saved = state?.profiles.find(item => item.id === profile.id);
  const stale = (saved?.revision ?? 0) !== profile.revision;
  const unchanged = Boolean(saved && sameLayout(profile, saved));
  const active = unchanged && state?.activeId === profile.id;

  return (
    <aside ref={bar} className={s.previewBar} tabIndex={-1} aria-label={t('chatLayout.previewTitle')}
      onKeyDown={event => {
        if (event.key !== 'Escape' || layouts.saving) return;
        event.stopPropagation();
        onClose();
      }}>
      <div className={s.previewText}>
        <small>{t('chatLayout.previewTitle')}</small>
        <strong>{profile.name}</strong>
      </div>
      <div className={s.actions}>
        <button type="button" className={settings.cancelBtn} disabled={layouts.saving} onClick={onClose}>
          {t(fromSettings ? 'chatLayout.backToEditor' : 'chatLayout.endPreview')}
        </button>
        <button type="button" className={settings.saveBtn} disabled={layouts.saving || stale || !state || active}
          onClick={async () => {
            if (!state) return;
            setError('');
            try {
              await layouts.change(unchanged
                ? { action: 'activate', id: profile.id, revision: state.revision }
                : { action: 'save', profile, apply: true });
              onApply();
            } catch {
              setError(t('chatLayout.failed'));
            }
          }}>{t(unchanged ? 'chatLayout.apply' : 'chatLayout.saveApply')}</button>
      </div>
      {(error || (stale && layouts.state)) && <p className={s.error} role="alert">{error || t('chatLayout.stale')}</p>}
    </aside>
  );
}
