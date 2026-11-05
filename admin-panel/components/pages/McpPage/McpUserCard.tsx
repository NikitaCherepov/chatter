'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { Select } from '../../ui/Select/Select';
export function McpUserCard({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    policy: { override: string; allow_custom: boolean; enabled: boolean };
    connections: Array<{
      id: number;
      name: string;
      url: string;
      blocked: boolean;
      enabled: number;
    }>;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<typeof data>('/api/mcp/users/' + userId)
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active) setError(t('mcp.error'));
      });
    return () => {
      active = false;
    };
  }, [userId]);
  return (
    <Card title="MCP" description={t('mcp.userHelp')}>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <Select
            value={data.policy.override}
            disabled={busy}
            options={[
              { value: 'inherit', label: t('mcp.inherit') },
              { value: 'allow', label: t('mcp.allow') },
              { value: 'deny', label: t('mcp.deny') },
            ]}
            onChange={(override) => {
              setBusy(true);
              setError('');
              void api<{ policy: NonNullable<typeof data>['policy'] }>('/api/mcp/users/' + userId, {
                method: 'PUT',
                body: JSON.stringify({ override }),
              })
                .then((value) => setData({ ...data, policy: value.policy }))
                .catch(() => setError(t('mcp.error')))
                .finally(() => setBusy(false));
            }}
          />
          <p>
            {t('mcp.allowCustom')}: {data.policy.allow_custom ? t('mcp.allow') : t('mcp.deny')}
          </p>
          {data.connections.map((connection) => (
            <p key={connection.id}>
              <strong>{connection.name}</strong> · {connection.url}{' '}
              {connection.blocked ? '(' + t('mcp.blocked') + ')' : ''}
            </p>
          ))}
          {!data.connections.length && <p>{t('mcp.empty')}</p>}
        </>
      )}
    </Card>
  );
}
