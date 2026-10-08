import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import * as api from '../lib/api';
import { useMemoryKey } from '../lib/memory-queries';
import s from './MemorySetupNotice.module.scss';

export function MemorySetupNotice({ importing = false, relevant = true }: { importing?: boolean; relevant?: boolean }) {
  const { t } = useTranslation();
  const queryKey = useMemoryKey('/api/v1/memory/status');
  const status = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.apiFetch<{ configured: boolean }>('/api/v1/memory/status', { signal }),
    enabled: relevant,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    retry: 1,
  });
  // Unknown/network failure is not proof of a missing configuration.
  if (!relevant || !status.isSuccess || status.data.configured !== false) return null;
  return <div className={s.notice} role="note">
    <svg className={s.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.4L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" /><path d="M12 16h.01" />
    </svg>
    <div>
      <div className={s.title}>{t('memorySetupNotice.title')}</div>
      {importing && <p className={s.text}>{t('memorySetupNotice.importHelp')}</p>}
    </div>
  </div>;
}
