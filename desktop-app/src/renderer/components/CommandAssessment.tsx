import { useTranslation } from 'react-i18next';
import type { CommandAssessment as Assessment } from '../lib/auto-confirmation-service';
import s from './AutoConfirmationSettings.module.scss';
import signals from './IntuitionDisclosure.module.scss';

export function CommandAssessment({ assessment }: { assessment: Assessment }) {
  const { t } = useTranslation();
  return (
    <div className={s.assessment}>
      {assessment.status === 'unavailable' ? (
        <span>{t('autoConfirmation.assessmentUnavailable')}</span>
      ) : (
        <>
          {(['auto', 'know'] as const).map((key) => (
            <div className={signals.signal} key={key}>
              <div className={signals.label}>
                <span>{t(`autoConfirmation.${key}`)}</span>
                <span>
                  {t(
                    key === 'auto'
                      ? 'autoConfirmation.riskScore'
                      : 'autoConfirmation.understandingScore',
                    {
                      score: Math.round((assessment[key] ?? 0) * 100),
                      threshold: Math.round(assessment.thresholds[key] * 100),
                    },
                  )}
                </span>
              </div>
              <meter
                min={0}
                max={1}
                value={assessment[key] ?? 0}
                aria-label={t(`autoConfirmation.${key}`)}
              />
            </div>
          ))}
          <strong>
            {t(
              assessment.approved
                ? 'autoConfirmation.approved'
                : 'autoConfirmation.confirmRequired',
            )}
          </strong>
        </>
      )}
    </div>
  );
}
