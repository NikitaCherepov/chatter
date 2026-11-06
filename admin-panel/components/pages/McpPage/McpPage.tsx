'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { Toggle } from '../../ui/Toggle/Toggle';
import { McpAccessSettings } from './McpAccessSettings';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import { Select } from '../../ui/Select/Select';
import { FormField } from '../../ui/FormField/FormField';
import { AnimatedDetails } from '../ModelsPage/AnimatedDetails';
import { McpIcon } from './McpIcon';
import s from './McpPage.module.css';
type Server = {
  id: number;
  name: string;
  url: string;
  description: string;
  allowed: number;
  recommended: number;
  transport: 'streamable-http' | 'stdio';
  source: string;
};
const empty = {
  name: '',
  url: '',
  description: '',
  allowed: true,
  recommended: true,
  transport: 'streamable-http' as 'streamable-http' | 'stdio',
  source: '',
};
export function McpPage() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState({ enabled: false, allow_custom: false, show_catalog: true }),
    [servers, setServers] = useState<Server[]>([]);
  const [draft, setDraft] = useState(empty),
    [editId, setEditId] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [remove, setRemove] = useState<Server | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [serverSearch, setServerSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formOpen) editor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [formOpen, editId]);
  const [search, setSearch] = useState(''),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogSearched, setCatalogSearched] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const load = async () => {
    const data = await api<{ policy: typeof policy; servers: Server[] }>('/api/mcp');
    setPolicy(data.policy);
    setServers(data.servers);
  };
  useEffect(() => {
    void load()
      .catch(() => setError(t('mcp.error')))
      .finally(() => setLoading(false));
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
    setCatalogLoading(true);
    setError('');
    try {
      const data = await api<{ items: any[]; next_cursor: string | null }>(
        '/api/mcp/catalog?' +
          new URLSearchParams({ search: applied, cursor: more ? next || '' : '' }),
      );
      setCatalogQuery(applied);
      setCatalogSearched(true);
      setItems([
        ...new Map(
          [...(more ? items : []), ...data.items].map((item) => [
            item.name + '\n' + (item.package?.identifier || item.url),
            item,
          ]),
        ).values(),
      ]);
      setNext(data.next_cursor);
    } catch {
      setError(t('mcp.error'));
    } finally {
      setBusy(false);
      setCatalogLoading(false);
    }
  };
  const closeForm = () => {
    setFormOpen(false);
  };
  const editServer = (server: Server) => {
    setEditId(server.id);
    setDraft({ ...server, allowed: !!server.allowed, recommended: !!server.recommended });
    setFormOpen(true);
  };
  const selectItem = (item: any) => {
    setEditId(null);
    setDraft({
      ...empty,
      transport: item.transport === 'stdio' ? 'stdio' : 'streamable-http',
      source: item.package?.identifier
        ? item.package.identifier +
          (item.package.version && item.package.version !== 'latest'
            ? '@' + item.package.version
            : '')
        : '',
      name: item.title || item.name,
      url: item.url || '',
      description: item.description || '',
    });
    setFormOpen(true);
    editor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const visibleServers = servers.filter((server) =>
    (server.name + ' ' + server.description + ' ' + server.url + ' ' + server.source)
      .toLowerCase()
      .includes(serverSearch.trim().toLowerCase()),
  );
  return (
    <div className={s.stack}>
      {error && (
        <p className={s.status} role="alert">
          {error}
        </p>
      )}
      <Card
        className={s.policyCard}
        title={t('mcp.policy')}
        description={t('mcp.policyHelp')}
        aside={
          <span className={s.policyToggle}>
            <Toggle
              checked={policy.enabled}
              disabled={busy || loading}
              label={t('mcp.enabled')}
              onChange={(enabled) =>
                void run(() =>
                  api('/api/mcp/policy', { method: 'PUT', body: JSON.stringify({ enabled }) }),
                )
              }
            />
          </span>
        }
      >
        <McpAccessSettings />
      </Card>
      <Card
        title={t('mcp.servers')}
        description={t('mcp.design.serversHelp')}
        aside={<span className={s.count}>{servers.length}</span>}
      >
        <div ref={editor} className={s.editor}>
          <AnimatedDetails
            open={formOpen}
            onToggle={(open) => {
              if (busy) return;
              if (open && !formOpen) {
                setEditId(null);
                setDraft(empty);
              }
              setFormOpen(open);
            }}
            className={s.disclosure}
            summary={
              <>
                <span className={s.sectionLabel}>
                  <McpIcon name="plus" />
                  {formOpen && editId ? t('mcp.edit') + ': ' + draft.name : t('mcp.addServer')}
                </span>
                <span className={`${s.chevron} ${formOpen ? s.expanded : ''}`} aria-hidden="true">
                  <McpIcon name="chevron" />
                </span>
              </>
            }
          >
            <form
              className={s.form}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api('/api/mcp/servers' + (editId ? '/' + editId : ''), {
                    method: editId ? 'PATCH' : 'POST',
                    body: JSON.stringify(draft),
                  });
                  setFormOpen(false);
                  setDraft(empty);
                  setEditId(null);
                });
              }}
            >
              <FormField label={t('mcp.name')}>
                <input
                  value={draft.name}
                  required
                  maxLength={120}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </FormField>
              <FormField label={t('mcp.design.connectionType')}>
                <Select
                  value={draft.transport}
                  disabled={busy}
                  aria-label={t('mcp.design.connectionType')}
                  onChange={(value) =>
                    setDraft({ ...draft, transport: value as typeof draft.transport })
                  }
                  options={[
                    { value: 'streamable-http', label: t('mcp.design.remote') },
                    { value: 'stdio', label: t('mcp.design.local') },
                  ]}
                />
              </FormField>
              <div className={s.wide}>
                <FormField
                  label={t(
                    draft.transport === 'stdio' ? 'mcp.design.command' : 'mcp.design.address',
                  )}
                  hint={t(
                    draft.transport === 'stdio' ? 'mcp.design.localHint' : 'mcp.design.remoteHint',
                  )}
                >
                  <input
                    required
                    disabled={busy}
                    type={draft.transport === 'stdio' ? 'text' : 'url'}
                    maxLength={8000}
                    value={draft.transport === 'stdio' ? draft.source : draft.url}
                    placeholder={
                      draft.transport === 'stdio'
                        ? 'npx -y @playwright/mcp@latest'
                        : 'https://example.com/mcp'
                    }
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [draft.transport === 'stdio' ? 'source' : 'url']: event.target.value,
                      })
                    }
                  />
                </FormField>
              </div>
              <div className={s.wide}>
                <FormField label={t('mcp.description')}>
                  <textarea
                    rows={3}
                    value={draft.description}
                    disabled={busy}
                    maxLength={1500}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </FormField>
              </div>
              <div className={`${s.formToggles} ${s.wide}`}>
                <Toggle
                  checked={draft.allowed}
                  disabled={busy}
                  label={t('mcp.allowed')}
                  onChange={(allowed) => setDraft({ ...draft, allowed })}
                />
                <Toggle
                  checked={draft.recommended}
                  disabled={busy}
                  label={t('mcp.design.recommend')}
                  onChange={(recommended) => setDraft({ ...draft, recommended })}
                />
              </div>
              <div className={`${s.actions} ${s.wide}`}>
                <button type="submit" disabled={busy}>
                  {t(editId ? 'mcp.save' : 'mcp.addServer')}
                </button>
                <button
                  type="button"
                  className="buttonSecondary"
                  disabled={busy}
                  onClick={closeForm}
                >
                  {t('mcp.cancel')}
                </button>
              </div>
              {editId && <p className={`${s.hint} ${s.wide}`}>{t('mcp.urlChangeHelp')}</p>}
            </form>
          </AnimatedDetails>
        </div>
        {loading ? (
          <p className={s.status} role="status">
            {t('common.loading')}
          </p>
        ) : (
          <>
            {servers.length > 0 && (
              <div className={s.search}>
                <McpIcon name="search" />
                <input
                  aria-label={t('mcp.design.findServer')}
                  placeholder={t('mcp.design.findServer')}
                  value={serverSearch}
                  onChange={(event) => setServerSearch(event.target.value)}
                />
              </div>
            )}
            <div className={s.serverGrid}>
              {visibleServers.map((server) => (
                <article className={s.serverCard} key={server.id}>
                  <div className={s.cardHeading}>
                    <span className={s.icon}>
                      <McpIcon name={server.transport === 'stdio' ? 'monitor' : 'globe'} />
                    </span>
                    <div>
                      <h3>{server.name}</h3>
                      <span className={s.hint}>
                        {t(server.transport === 'stdio' ? 'mcp.design.local' : 'mcp.design.remote')}
                      </span>
                    </div>
                  </div>
                  {server.description && <p className={s.description}>{server.description}</p>}
                  {server.transport === 'stdio' ? (
                    <code className={s.endpoint}>{server.source}</code>
                  ) : (
                    <a
                      className={s.endpoint}
                      href={server.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {server.url}
                      <span aria-hidden="true"> ↗</span>
                    </a>
                  )}
                  <div className={s.serverControls}>
                    <Toggle
                      checked={!!server.allowed}
                      disabled={busy}
                      label={t('mcp.allowed')}
                      onChange={(allowed) =>
                        void run(() =>
                          api('/api/mcp/servers/' + server.id, {
                            method: 'PATCH',
                            body: JSON.stringify({ ...server, allowed }),
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
                            body: JSON.stringify({
                              ...server,
                              allowed: !!server.allowed,
                              recommended,
                            }),
                          }),
                        )
                      }
                    />
                  </div>
                  <div className={s.cardActions}>
                    <button
                      type="button"
                      className="buttonSecondary"
                      disabled={busy}
                      onClick={() => editServer(server)}
                    >
                      {t('mcp.edit')}
                    </button>
                    <button
                      type="button"
                      className={s.remove}
                      disabled={busy}
                      onClick={() => setRemove(server)}
                    >
                      {t('mcp.remove')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {!visibleServers.length && (
              <p className={s.status}>
                {t(serverSearch ? 'mcp.design.noServersFound' : 'mcp.design.noServers')}
              </p>
            )}
          </>
        )}
      </Card>
      <Card title={t('mcp.catalog')} description={t('mcp.design.registryHelp')}>
        <form
          className={s.catalogSearch}
          onSubmit={(event) => {
            event.preventDefault();
            void browse();
          }}
        >
          <div className={s.search}>
            <McpIcon name="search" />
            <input
              aria-label={t('mcp.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('mcp.design.searchCatalog')}
            />
          </div>
          <button disabled={busy || (!!search.trim() && search.trim().length < 3)}>
            {t('mcp.search')}
          </button>
        </form>
        {!items.length && (
          <p className={s.status} role="status">
            {t(
              catalogLoading
                ? 'common.loading'
                : catalogSearched
                  ? 'mcp.design.noServersFound'
                  : 'mcp.design.catalogEmpty',
            )}
          </p>
        )}
        <div className={s.serverGrid}>
          {items.map((item, index) => (
            <article
              className={s.catalogCard}
              key={item.name + (item.package?.identifier || item.url) + index}
            >
              <div className={s.cardHeading}>
                <span className={s.icon}>
                  <McpIcon name={item.transport === 'stdio' ? 'monitor' : 'globe'} />
                </span>
                <div>
                  <h3>{item.title || item.name}</h3>
                  <span className={s.hint}>
                    {t(item.transport === 'stdio' ? 'mcp.design.local' : 'mcp.design.remote')}
                  </span>
                </div>
              </div>
              {item.title && item.title !== item.name && <p className={s.hint}>{item.name}</p>}
              <p className={s.description}>{item.description}</p>
              {item.url ? (
                <a className={s.endpoint} href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.url} ↗
                </a>
              ) : (
                item.package?.identifier && (
                  <code className={s.endpoint}>{item.package.identifier}</code>
                )
              )}
              <dl className={s.metadata}>
                <div>
                  <dt>{t('mcp.version')}</dt>
                  <dd>{item.version || '—'}</dd>
                </div>
                <div>
                  <dt>{t('mcp.publisher')}</dt>
                  <dd>{item.publisher || item.name.split('/')[0]}</dd>
                </div>
              </dl>
              <div className={s.links}>
                {[
                  { url: item.repository_url, label: t('mcp.repository'), icon: 'code' },
                  { url: item.website_url, label: t('mcp.website'), icon: 'globe' },
                  { url: item.registry_url, label: t('mcp.registryEntry'), icon: 'book' },
                ]
                  .filter((link) => link.url)
                  .map((link) => (
                    <a href={link.url} key={link.label} target="_blank" rel="noopener noreferrer">
                      <McpIcon name={link.icon} />
                      {link.label}
                      <span aria-hidden="true">↗</span>
                    </a>
                  ))}
              </div>
              <div className={s.catalogAction}>
                <button
                  type="button"
                  className="buttonSecondary"
                  disabled={busy}
                  onClick={() => selectItem(item)}
                >
                  {t('mcp.select')}
                </button>
              </div>
            </article>
          ))}
        </div>
        {next && (
          <div className={s.actions}>
            <button
              className="buttonSecondary"
              disabled={busy || search.trim() !== catalogQuery}
              onClick={() => void browse(true)}
            >
              {t('mcp.more')}
            </button>
          </div>
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
