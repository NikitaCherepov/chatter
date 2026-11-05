'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { Toggle } from '../../ui/Toggle/Toggle';
import { McpAccessSettings } from './McpAccessSettings';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import s from '../ModelApiPage/ModelApiPage.module.css';
type Server = {
  id: number;
  name: string;
  url: string;
  description: string;
  allowed: number;
  recommended: number;
};
const empty = { name: '', url: '', description: '', allowed: true, recommended: false };
export function McpPage() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState({ enabled: false, allow_custom: false, show_catalog: true }),
    [servers, setServers] = useState<Server[]>([]);
  const [draft, setDraft] = useState(empty),
    [editId, setEditId] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [remove, setRemove] = useState<Server | null>(null);
  const [search, setSearch] = useState(''),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const load = async () => {
    const data = await api<{ policy: typeof policy; servers: Server[] }>('/api/mcp');
    setPolicy(data.policy);
    setServers(data.servers);
  };
  useEffect(() => {
    void load().catch(() => setError(t('mcp.error')));
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e: any) {
      setError(t('mcp.error') + ': ' + String(e?.message || ''));
    } finally {
      setBusy(false);
    }
  };
  const browse = async (more = false) => {
    if (busy) return;
    const applied = more ? catalogQuery : search.trim();
    if (applied && applied.length < 3) return;
    setBusy(true);
    setError('');
    try {
      const data = await api<{ items: any[]; next_cursor: string | null }>(
        '/api/mcp/catalog?' +
          new URLSearchParams({ search: applied, cursor: more ? next || '' : '' }),
      );
      setCatalogQuery(applied);
      setItems([
        ...new Map(
          [...(more ? items : []), ...data.items].map((item) => [
            item.name + '\n' + item.url,
            item,
          ]),
        ).values(),
      ]);
      setNext(data.next_cursor);
    } catch {
      setError(t('mcp.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.stack}>
      {error && <p role="alert">{error}</p>}
      <Card title={t('mcp.policy')}>
        <div className={s.copy}>
          <Toggle
            checked={policy.enabled}
            disabled={busy}
            label={t('mcp.enabled')}
            onChange={(enabled) =>
              void run(() =>
                api('/api/mcp/policy', {
                  method: 'PUT',
                  body: JSON.stringify({ enabled }),
                }),
              )
            }
          />
        </div>
        <p className={s.help}>{t('mcp.policyHelp')}</p>
        <McpAccessSettings />
      </Card>
      <Card title={t('mcp.servers')}>
        {servers.map((server) => (
          <div className={s.secret} key={server.id}>
            <strong>
              {server.name} {server.recommended ? '★' : ''}
            </strong>
            <p>{server.description}</p>
            <a href={server.url} target="_blank" rel="noopener noreferrer">
              {server.url}
            </a>
            <div className={s.copy}>
              <Toggle
                checked={!!server.allowed}
                disabled={busy}
                label={t('mcp.allowed')}
                onChange={(allowed) =>
                  void run(() =>
                    api('/api/mcp/servers/' + server.id, {
                      method: 'PATCH',
                      body: JSON.stringify({
                        ...server,
                        allowed,
                        recommended: !!server.recommended,
                      }),
                    }),
                  )
                }
              />
              <Toggle
                checked={!!server.recommended}
                disabled={busy}
                label={t('mcp.recommended')}
                onChange={(recommended) =>
                  void run(() =>
                    api('/api/mcp/servers/' + server.id, {
                      method: 'PATCH',
                      body: JSON.stringify({ ...server, allowed: !!server.allowed, recommended }),
                    }),
                  )
                }
              />
              <button
                disabled={busy}
                onClick={() => {
                  setEditId(server.id);
                  setDraft({
                    ...server,
                    allowed: !!server.allowed,
                    recommended: !!server.recommended,
                  });
                }}
              >
                {t('mcp.edit')}
              </button>
              <button disabled={busy} onClick={() => setRemove(server)}>
                {t('mcp.remove')}
              </button>
            </div>
          </div>
        ))}
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api('/api/mcp/servers' + (editId ? '/' + editId : ''), {
                method: editId ? 'PATCH' : 'POST',
                body: JSON.stringify(draft),
              });
              setDraft(empty);
              setEditId(null);
            });
          }}
        >
          <label>
            {t('mcp.name')}
            <input
              value={draft.name}
              required
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            URL
            <input
              type="url"
              required
              placeholder="https://example.com/mcp"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </label>
          <label className={s.wide}>
            {t('mcp.description')}
            <input
              value={draft.description}
              maxLength={1500}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <Toggle
            checked={draft.allowed}
            label={t('mcp.allowed')}
            onChange={(allowed) => setDraft({ ...draft, allowed })}
          />
          <Toggle
            checked={draft.recommended}
            label={t('mcp.recommended')}
            onChange={(recommended) => setDraft({ ...draft, recommended })}
          />
          <button type="submit" disabled={busy}>
            {editId ? t('mcp.save') : t('mcp.addServer')}
          </button>
          {editId && (
            <button
              type="button"
              onClick={() => {
                setEditId(null);
                setDraft(empty);
              }}
            >
              {t('mcp.cancel')}
            </button>
          )}
        </form>
        <p className={s.help}>{t('mcp.urlChangeHelp')}</p>
      </Card>
      <Card title={t('mcp.catalog')} description={t('mcp.catalogHelp')}>
        <form
          className={s.copy}
          onSubmit={(e) => {
            e.preventDefault();
            void browse();
          }}
        >
          <input
            aria-label={t('mcp.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('mcp.search')}
          />
          <button disabled={busy || (!!search.trim() && search.trim().length < 3)}>
            {t('mcp.search')}
          </button>
        </form>
        {items.map((item, index) => (
          <div className={s.secret} key={item.url + index}>
            <strong>{item.title || item.name}</strong>
            {item.title && item.title !== item.name && <small>{item.name}</small>}
            <p>{item.description}</p>
            <p className={s.help}>
              {t('mcp.version')}: {item.version || '—'} · Streamable HTTP · {t('mcp.publisher')}:{' '}
              {item.publisher || item.name.split('/')[0]}
            </p>
            <div className={s.copy}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {item.url}
              </a>
              {item.repository_url && (
                <a href={item.repository_url} target="_blank" rel="noopener noreferrer">
                  {t('mcp.repository')}
                </a>
              )}
              {item.website_url && (
                <a href={item.website_url} target="_blank" rel="noopener noreferrer">
                  {t('mcp.website')}
                </a>
              )}
              {item.registry_url && (
                <a href={item.registry_url} target="_blank" rel="noopener noreferrer">
                  {t('mcp.registryEntry')}
                </a>
              )}
            </div>
            <button
              disabled={busy}
              onClick={() => {
                setEditId(null);
                setDraft({
                  ...empty,
                  name: item.name,
                  url: item.url,
                  description: item.description,
                });
              }}
            >
              {t('mcp.select')}
            </button>
          </div>
        ))}
        {next && (
          <button
            disabled={busy || search.trim() !== catalogQuery}
            onClick={() => void browse(true)}
          >
            {t('mcp.more')}
          </button>
        )}
      </Card>
      {remove && (
        <ConfirmModal
          title={t('mcp.remove')}
          onClose={() => {
            if (!busy) setRemove(null);
          }}
          actions={[
            { label: t('mcp.cancel'), disabled: busy, onClick: () => setRemove(null) },
            {
              label: t('mcp.remove'),
              variant: 'danger',
              disabled: busy,
              onClick: () =>
                run(async () => {
                  await api('/api/mcp/servers/' + remove.id, { method: 'DELETE' });
                  setRemove(null);
                }),
            },
          ]}
        >
          <p>{remove.name}</p>
        </ConfirmModal>
      )}
    </div>
  );
}
