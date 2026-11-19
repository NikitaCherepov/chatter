import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmationCard } from './ConfirmationCard';
import { AppearanceSample } from './AppearancePanel';
import { useAppearance } from '../lib/appearance-service';
import {
  APPEARANCE_APPLIED_EVENT,
  finishAppearancePreview,
  previewAppearance,
} from '../lib/appearance-runtime';
import type { AppearanceProfile } from '../lib/appearance-schema';
import s from './SettingsModal.module.scss';
import styles from './AppearancePanel.module.scss';
export type AppearanceProposal = { proposal_id: string; profile: AppearanceProfile };
export function AppearanceConfirmation({
  proposal,
  onResolved,
}: {
  proposal: AppearanceProposal;
  onResolved: () => void;
}) {
  useEffect(() => {
    const done = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.id === proposal.profile.id && detail.revision === proposal.profile.revision)
        onResolved();
    };
    window.addEventListener(APPEARANCE_APPLIED_EVENT, done);
    return () => window.removeEventListener(APPEARANCE_APPLIED_EVENT, done);
  }, [proposal, onResolved]);
  const query = useAppearance(),
    { t } = useTranslation(),
    [error, setError] = useState('');
  return (
    <ConfirmationCard
      id={proposal.proposal_id}
      title={t('appearance.proposal')}
      actions={
        <>
          <button
            className={s.cancelBtn}
            disabled={query.saving}
            onClick={async () => {
              try {
                const profile =
                  query.data?.activeId === proposal.profile.id
                    ? {
                        ...proposal.profile,
                        id: crypto.randomUUID(),
                        revision: 0,
                        name: proposal.profile.name,
                      }
                    : proposal.profile;
                await query.change({ action: 'save', profile, apply: false });
                previewAppearance(null);
                onResolved();
              } catch {
                setError(t('appearance.failed'));
              }
            }}
          >
            {query.data?.activeId === proposal.profile.id
              ? t('appearance.copy')
              : t('appearance.save')}
          </button>
          <button className={s.cancelBtn} onClick={() => previewAppearance(proposal.profile)}>
            {t('appearance.preview')}
          </button>
          <button
            className={s.saveBtn}
            disabled={query.saving}
            onClick={async () => {
              try {
                await query.change({ action: 'save', profile: proposal.profile, apply: true });
                finishAppearancePreview(proposal.profile);
                onResolved();
              } catch {
                setError(t('appearance.failed'));
              }
            }}
          >
            {t('appearance.saveApply')}
          </button>
          <button
            className={s.cancelBtn}
            disabled={query.saving}
            onClick={() => {
              previewAppearance(null);
              onResolved();
            }}
          >
            {t('appearance.dismiss')}
          </button>
        </>
      }
    >
      <div className={styles.section}>
        <strong>{proposal.profile.name}</strong>
        <AppearanceSample profile={proposal.profile} />
        <p className={styles.hint}>{t('appearance.proposalHelp')}</p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </ConfirmationCard>
  );
}
