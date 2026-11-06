'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
export function McpUserCard({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    connections: Array<{
      transport?: string;
      id: number;
      name: string;
      url: string;
      blocked: boolean;
      enabled: number;
    }>;
  } | null>(null);
  const [error, setError] = useState('');
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
          {data.connections.map((connection) => (
            <p key={connection.id}>
              <strong>{connection.name}</strong> ·{' '}
              {connection.transport === 'stdio' ? (
                <span>stdio</span>
              ) : (
                <a href={connection.url} target="_blank" rel="noopener noreferrer">
                  {connection.url}
                </a>
              )}{' '}
              {connection.blocked ? '(' + t('mcp.blocked') + ')' : ''}
            </p>
          ))}
          {!data.connections.length && <p>{t('mcp.empty')}</p>}
        </>
      )}
    </Card>
  );
}
