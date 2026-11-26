import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAppearanceFailure, type AppearanceFailureReport } from '../lib/appearance-failure';
import buttons from './ConfirmDialog.module.scss';
import s from './AppearanceFailureNotice.module.scss';

export function AppearanceFailureNotice({
  report,
  floating,
  onRetry,
  onDismiss,
}: {
  report: AppearanceFailureReport;
  floating: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation(),
    titleId = useId();
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  const title = t(
    report.recovering
      ? 'appearance.failure.recovering'
      : report.retained
        ? 'appearance.failure.updateTitle'
        : report.phase === 'startup'
          ? 'appearance.failure.startupTitle'
          : 'appearance.failure.runtimeTitle',
  );
  const text = formatAppearanceFailure(report);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <aside
      className={`${s.notice} ${floating ? s.floating : ''}`}
      role={report.recovering ? 'status' : 'alert'}
      aria-labelledby={titleId}
      data-appearance-failure
    >
      <strong id={titleId}>{title}</strong>
      {report.theme && <span className={s.theme}>{report.theme.name}</span>}
      <p>{t('appearance.failure.reason.' + report.reason)}</p>
      {report.detail && <p className={s.message}>{report.detail}</p>}
      {!report.recovering && (
        <p>{t(report.retained ? 'appearance.failure.retained' : 'appearance.failure.native')}</p>
      )}
      <details>
        <summary>{t('appearance.failure.details')}</summary>
        <pre tabIndex={0} data-appearance-failure-details>
          {text}
        </pre>
      </details>
      {copyError && <p role="alert">{t('appearance.failure.copyFailed')}</p>}
      <div className={s.actions}>
        <button
          type="button"
          className={buttons.confirmPrimary}
          disabled={report.recovering}
          onClick={onRetry}
          data-appearance-failure-retry
        >
          {t('appearance.failure.retry')}
        </button>
        <button
          type="button"
          className={buttons.confirmCancel}
          onClick={() => void copy()}
          data-appearance-failure-copy
        >
          {t(copied ? 'appearance.failure.copied' : 'appearance.failure.copy')}
        </button>
        <button type="button" className={buttons.confirmCancel} onClick={onDismiss}>
          {t('common.close')}
        </button>
      </div>
    </aside>
  );
}
