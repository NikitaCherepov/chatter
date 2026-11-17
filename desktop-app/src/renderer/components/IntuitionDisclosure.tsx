import { useTranslation } from 'react-i18next';
import type { IntuitionSnapshot } from '../lib/intuition-service';
import { AnimatedDetails } from './AnimatedDisclosure';
import s from './IntuitionDisclosure.module.scss';

export function IntuitionDisclosure({ snapshot }: { snapshot: IntuitionSnapshot }) {
  const { t } = useTranslation();
  return (
    <AnimatedDetails
      className={s.intuition}
      summary={
        <>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
          <span>{t('intuition.title')}</span>
          {snapshot.status === 'unavailable' && (
            <span className={s.hint}>· {t('intuition.unavailable')}</span>
          )}
        </>
      }
    >
      <div className={s.content}>
        <p className={s.hint}>
          {t(snapshot.status === 'ready' ? 'intuition.scoresHelp' : 'intuition.unavailableHelp')}
        </p>
        {snapshot.signals.map((signal) => (
          <div className={s.signal} key={signal.id}>
            <div className={s.label}>
              <span>{signal.name}</span>
              <span>{Math.round(signal.probability * 100)}%</span>
            </div>
            <meter min={0} max={1} value={signal.probability} aria-label={signal.name} />
            <p className={s.hint}>{signal.question}</p>
          </div>
        ))}
        <p className={s.hint}>
          {snapshot.model} · {t('intuition.messages', { count: snapshot.historyMessages })}
        </p>
      </div>
    </AnimatedDetails>
  );
}
