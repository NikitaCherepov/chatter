import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAutoConfirmation } from '../lib/auto-confirmation-queries';
import type {
  ApprovalScope,
  ApprovalSettings,
  ApprovalStrictness,
  ApprovalThresholds,
  AutoConfirmationConfig,
} from '../lib/auto-confirmation-service';
import Slider from './Slider';
import { AnimatedCollapse } from './AnimatedDisclosure';
import Checkbox from './Checkbox';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import shared from './SettingsModal.module.scss';
import layout from './IntuitionSettings.module.scss';
import rows from './RestrictionsSettings.module.scss';
import toggle from './MemoryPopover.module.scss';
import s from './AutoConfirmationSettings.module.scss';

export function AutoConfirmationSettings({ serverId }: { serverId?: number }) {
  const { t } = useTranslation();
  const id = useId();
  const { query, save } = useAutoConfirmation();
  const [resetOpen, setResetOpen] = useState(false);
  const [editingScope, setEditingScope] = useState<ApprovalScope | null>(null);
  const config = query.data;
  const change = async (update: Parameters<typeof save.mutateAsync>[0]) => {
    try {
      await save.mutateAsync(update);
      return true;
    } catch {
      toast.error(t('autoConfirmation.saveFailed'));
      return false;
    }
  };
  if (!config)
    return (
      <div className={serverId ? s.embedded : layout.loading}>
        {query.isPending ? (
          t('common.loading')
        ) : (
          <button className={shared.cancelBtn} onClick={() => void query.refetch()}>
            {t('intuition.retry')}
          </button>
        )}
      </div>
    );

  const busy = save.isPending;
  const updateScope = (scope: ApprovalScope, patch: Partial<ApprovalSettings>) => {
    const settings = scope === 'pc' ? config.settings.pc : config.settings;
    return change({
      revision: config.revision,
      scope,
      enabled: settings.enabled,
      strictness: settings.strictness,
      customThresholds: settings.customThresholds,
      ...patch,
    });
  };

  if (serverId !== undefined) {
    const override = config.settings.overrides[String(serverId)];
    const enabled = override ?? config.settings.enabled;
    const thresholds = config.thresholds[config.settings.strictness];
    return (
      <section className={s.embedded} aria-label={t('autoConfirmation.title')}>
        <div className={rows.row}>
          <span className={rows.icon}>
            <Icon name="server" size={18} />
          </span>
          <div className={rows.text}>
            <span id={id + '-server'} className={rows.label}>
              {t('autoConfirmation.title')}
            </span>
            <p>
              {t(
                override === undefined
                  ? 'autoConfirmation.inherited'
                  : 'autoConfirmation.overrideStatus',
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby={id + '-server'}
            disabled={busy || override === undefined}
            className={`${toggle.toggle} ${enabled ? toggle.toggleActive : ''}`}
            onClick={() => void change({ revision: config.revision, serverId, enabled: !enabled })}
          >
            <span />
          </button>
        </div>
        <Checkbox
          checked={override !== undefined}
          disabled={busy}
          label={t('autoConfirmation.override')}
          onChange={(checked) =>
            void change({ revision: config.revision, serverId, enabled: checked ? enabled : null })
          }
        />
        <p className={layout.help}>
          {t('autoConfirmation.currentMode', {
            mode: t('autoConfirmation.' + config.settings.strictness),
            auto: Math.round(thresholds.auto * 100),
            know: Math.round(thresholds.know * 100),
          })}
        </p>
        {!config.available && <p className={layout.help}>{t('autoConfirmation.unavailable')}</p>}
      </section>
    );
  }

  return (
    <div className={layout.panel}>
      <div className={layout.content}>
        <div className={layout.fields}>
          <header className={layout.heading}>
            <h3 className={shared.panelTitle}>{t('autoConfirmation.title')}</h3>
            <p className={s.description}>{t('autoConfirmation.description')}</p>
          </header>
          {!config.available && (
            <p className={layout.notice}>{t('autoConfirmation.unavailable')}</p>
          )}
          <section className={rows.group} aria-labelledby={id + '-commands'}>
            <h3 id={id + '-commands'}>{t('autoConfirmation.commands')}</h3>
            {(['pc', 'servers'] as ApprovalScope[]).map((scope) => {
              const settings = scope === 'pc' ? config.settings.pc : config.settings;
              const thresholds = scope === 'pc' ? config.pcThresholds : config.thresholds;
              const expanded = editingScope === scope;
              const labelId = id + '-' + scope;
              return (
                <section className={s.scopeSection} key={scope}>
                  <div className={rows.row}>
                    <span className={rows.icon}>
                      <Icon name={scope === 'pc' ? 'monitor' : 'server'} size={18} />
                    </span>
                    <div className={rows.text}>
                      <button
                        type="button"
                        className={s.scopeSummary}
                        aria-expanded={expanded}
                        aria-controls={labelId + '-editor'}
                        onClick={() => setEditingScope(expanded ? null : scope)}
                      >
                        <span id={labelId} className={rows.label}>
                          {t('autoConfirmation.' + scope + 'Title')}
                        </span>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          className={expanded ? layout.chevronOpen : layout.chevron}
                        >
                          <path d="m9 5 7 7-7 7" />
                        </svg>
                      </button>
                      <p id={labelId + '-hint'}>{t('autoConfirmation.' + scope + 'Help')}</p>
                      <small className={layout.help}>
                        {t('autoConfirmation.currentMode', {
                          mode: t('autoConfirmation.' + settings.strictness),
                          auto: Math.round(thresholds[settings.strictness].auto * 100),
                          know: Math.round(thresholds[settings.strictness].know * 100),
                        })}
                      </small>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.enabled}
                      aria-labelledby={labelId}
                      aria-describedby={labelId + '-hint'}
                      disabled={busy}
                      className={`${toggle.toggle} ${settings.enabled ? toggle.toggleActive : ''}`}
                      onClick={() => {
                        if (!settings.enabled) setEditingScope(scope);
                        void updateScope(scope, { enabled: !settings.enabled });
                      }}
                    >
                      <span />
                    </button>
                  </div>
                  <AnimatedCollapse open={expanded}>
                    <div id={labelId + '-editor'} className={s.scopeEditor}>
                      <ModeSettings
                        value={settings}
                        thresholds={thresholds}
                        disabled={busy}
                        onChange={(patch) => updateScope(scope, patch)}
                      />
                      {scope === 'servers' && (
                        <div className={s.resetArea}>
                          <p className={layout.help}>{t('autoConfirmation.inheritanceHelp')}</p>
                          <span className={layout.help}>
                            {t('autoConfirmation.overrides', {
                              count: Object.keys(config.settings.overrides).length,
                            })}
                          </span>
                          <button
                            type="button"
                            className={shared.cancelBtn}
                            disabled={busy || !Object.keys(config.settings.overrides).length}
                            onClick={() => setResetOpen(true)}
                          >
                            {t('autoConfirmation.reset')}
                          </button>
                        </div>
                      )}
                    </div>
                  </AnimatedCollapse>
                </section>
              );
            })}
          </section>
          <section className={s.section}>
            <h4>{t('autoConfirmation.howItWorks')}</h4>
            <div className={s.predicate}>
              <Icon name="shield" size={18} />
              <div>
                <strong>{t('autoConfirmation.auto')}</strong>
                <p>{t('autoConfirmation.autoHelp')}</p>
              </div>
            </div>
            <div className={s.predicate}>
              <Icon name="terminal" size={18} />
              <div>
                <strong>{t('autoConfirmation.know')}</strong>
                <p>{t('autoConfirmation.knowHelp')}</p>
              </div>
            </div>
            <p className={layout.help}>{t('autoConfirmation.fallback')}</p>
          </section>
        </div>
      </div>
      <footer className={layout.footer}>
        <p className={layout.help} role="status">
          {t(busy ? 'common.saving' : 'autoConfirmation.instant')}
        </p>
      </footer>
      {resetOpen && (
        <ConfirmDialog
          open
          title={t('autoConfirmation.reset')}
          text={t('autoConfirmation.resetHelp')}
          confirmLabel={t('autoConfirmation.resetAction')}
          confirmTone="primary"
          confirmDisabled={busy}
          onCancel={() => setResetOpen(false)}
          onConfirm={() => {
            void change({ revision: config.revision, resetOverrides: true }).then((saved) => {
              if (saved) setResetOpen(false);
            });
          }}
        />
      )}
    </div>
  );
}

function ModeSettings({
  value,
  thresholds,
  disabled,
  onChange,
}: {
  value: ApprovalSettings;
  thresholds: AutoConfirmationConfig['thresholds'];
  disabled: boolean;
  onChange: (patch: Partial<ApprovalSettings>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  return (
    <div className={s.modeSettings}>
      <h4>{t('autoConfirmation.strictness')}</h4>
      <div className={s.modes}>
        {(['strict', 'normal', 'relaxed', 'custom'] as ApprovalStrictness[]).map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={value.strictness === mode}
            disabled={disabled}
            className={`${s.mode} ${value.strictness === mode ? s.selected : ''}`}
            onClick={() => void onChange({ strictness: mode })}
          >
            <strong>{t('autoConfirmation.' + mode)}</strong>
            <span>{t('autoConfirmation.' + mode + 'Help')}</span>
            <small>
              {t('autoConfirmation.modeThresholds', {
                auto: Math.round(thresholds[mode].auto * 100),
                know: Math.round(thresholds[mode].know * 100),
              })}
            </small>
          </button>
        ))}
      </div>
      <AnimatedCollapse open={value.strictness === 'custom'}>
        <CustomThresholds
          value={value.customThresholds}
          disabled={disabled}
          save={(customThresholds) => onChange({ strictness: 'custom', customThresholds })}
        />
      </AnimatedCollapse>
      <p className={layout.help}>{t('autoConfirmation.experimental')}</p>
    </div>
  );
}

function CustomThresholds({
  value,
  disabled,
  save,
}: {
  value: ApprovalThresholds;
  disabled: boolean;
  save: (thresholds: ApprovalThresholds) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const saving = useRef(false);
  useEffect(() => {
    latest.current = value;
    setDraft(value);
  }, [value]);
  const commit = async () => {
    if (
      saving.current ||
      disabled ||
      (latest.current.auto === value.auto && latest.current.know === value.know)
    )
      return;
    saving.current = true;
    try {
      await save(latest.current);
    } finally {
      saving.current = false;
    }
  };
  return (
    <div
      className={s.customSliders}
      onBlur={() => void commit()}
      onKeyUp={(event) => {
        if (
          [
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Home',
            'End',
            'PageUp',
            'PageDown',
          ].includes(event.key)
        )
          void commit();
      }}
    >
      {(['auto', 'know'] as const).map((key) => (
        <div key={key}>
          <div className={s.sliderHeading}>
            <strong>
              {t(key === 'auto' ? 'autoConfirmation.maxRisk' : 'autoConfirmation.minUnderstanding')}
            </strong>
            <span>{Math.round(draft[key] * 100)}%</span>
          </div>
          <Slider
            mode="numeric"
            layout="standalone"
            label={t(
              key === 'auto' ? 'autoConfirmation.maxRisk' : 'autoConfirmation.minUnderstanding',
            )}
            min={0}
            max={100}
            step={1}
            value={Math.round(draft[key] * 100)}
            disabled={disabled}
            onChange={(next) => {
              const updated = { ...latest.current, [key]: (next ?? 0) / 100 };
              latest.current = updated;
              setDraft(updated);
            }}
            onCommit={() => void commit()}
          />
        </div>
      ))}
    </div>
  );
}
