import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAutoConfirmation } from '../lib/auto-confirmation-queries';
import type { ApprovalStrictness, ApprovalThresholds } from '../lib/auto-confirmation-service';
import Slider from './Slider';
import { AnimatedCollapse } from './AnimatedDisclosure';
import Checkbox from './Checkbox';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import shared from './SettingsModal.module.scss';
import layout from './IntuitionSettings.module.scss';
import toggle from './MemoryPopover.module.scss';
import s from './AutoConfirmationSettings.module.scss';

export function AutoConfirmationSettings({ serverId }: { serverId?: number }) {
  const { t } = useTranslation();
  const { query, save } = useAutoConfirmation();
  const [resetOpen, setResetOpen] = useState(false);
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

  const override = serverId === undefined ? undefined : config.settings.overrides[String(serverId)];
  const enabled = override ?? config.settings.enabled;
  const busy = save.isPending;
  const thresholds = config.thresholds[config.settings.strictness];
  const enableSwitch = (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={t('autoConfirmation.enabled')}
      disabled={busy || (serverId !== undefined && override === undefined)}
      className={`${toggle.toggle} ${enabled ? toggle.toggleActive : ''}`}
      onClick={() =>
        void change(
          serverId === undefined
            ? {
                revision: config.revision,
                enabled: !enabled,
                strictness: config.settings.strictness,
              }
            : { revision: config.revision, serverId, enabled: !enabled },
        )
      }
    >
      <span />
    </button>
  );

  if (serverId !== undefined)
    return (
      <section className={s.embedded} aria-label={t('autoConfirmation.title')}>
        <div className={layout.enableRow}>
          <div>
            <strong>{t('autoConfirmation.title')}</strong>
            <p className={layout.help}>
              {t(override === undefined ? 'autoConfirmation.inherited' : 'autoConfirmation.custom')}
            </p>
          </div>
          {enableSwitch}
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
            mode: t(`autoConfirmation.${config.settings.strictness}`),
            auto: Math.round(thresholds.auto * 100),
            know: Math.round(thresholds.know * 100),
          })}
        </p>
        {!config.available && <p className={layout.help}>{t('autoConfirmation.unavailable')}</p>}
      </section>
    );

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
          <section className={s.section}>
            <div className={layout.enableRow}>
              <div>
                <strong>{t('autoConfirmation.enabled')}</strong>
                <p className={layout.help}>{t('autoConfirmation.defaultHelp')}</p>
              </div>
              {enableSwitch}
            </div>
          </section>
          <section className={s.section}>
            <h4>{t('autoConfirmation.strictness')}</h4>
            <div className={s.modes}>
              {(['strict', 'normal', 'relaxed', 'custom'] as ApprovalStrictness[]).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-pressed={config.settings.strictness === mode}
                  disabled={busy}
                  className={`${s.mode} ${config.settings.strictness === mode ? s.selected : ''}`}
                  onClick={() =>
                    void change({ revision: config.revision, enabled, strictness: mode })
                  }
                >
                  <strong>{t(`autoConfirmation.${mode}`)}</strong>
                  <span>{t(`autoConfirmation.${mode}Help`)}</span>
                  <small>
                    {t('autoConfirmation.modeThresholds', {
                      auto: Math.round(config.thresholds[mode].auto * 100),
                      know: Math.round(config.thresholds[mode].know * 100),
                    })}
                  </small>
                </button>
              ))}
            </div>
            <AnimatedCollapse open={config.settings.strictness === 'custom'}>
              <CustomThresholds
                value={config.settings.customThresholds}
                disabled={busy}
                save={(customThresholds) =>
                  change({
                    revision: config.revision,
                    enabled,
                    strictness: 'custom',
                    customThresholds,
                  })
                }
              />
            </AnimatedCollapse>
            <p className={layout.help}>{t('autoConfirmation.experimental')}</p>
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
          <section className={s.section}>
            <div className={layout.sectionHeader}>
              <h4>{t('settings.sections.servers')}</h4>
              <span className={layout.help}>
                {t('autoConfirmation.overrides', {
                  count: Object.keys(config.settings.overrides).length,
                })}
              </span>
            </div>
            <p className={layout.help}>{t('autoConfirmation.inheritanceHelp')}</p>
            <button
              type="button"
              className={shared.cancelBtn}
              disabled={busy || !Object.keys(config.settings.overrides).length}
              onClick={() => setResetOpen(true)}
            >
              {t('autoConfirmation.reset')}
            </button>
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
