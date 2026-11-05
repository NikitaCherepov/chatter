import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMcp } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import { Select } from './Select';
import Checkbox from './Checkbox';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function McpSettings() {
  const { t } = useTranslation(),
    { query, mutation } = useMcp();
  const [server, setServer] = useState(''),
    [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [token, setToken] = useState('');
  const [mode, setMode] = useState('search'),
    [timeout, setTimeoutValue] = useState(300);
  const [search, setSearch] = useState(''),
    [catalog, setCatalog] = useState<api.CatalogItem[]>([]),
    [next, setNext] = useState<string | null>(null),
    [catalogBusy, setCatalogBusy] = useState(false);
  const [authorization, setAuthorization] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    try {
      await mutation.mutateAsync(action);
    } catch (error: any) {
      if (String(error?.message || '').includes('mcp_server_changed')) {
        setServer('');
        setUrl('');
        setToken('');
        void query.refetch();
      }
      toast.error(t('mcp.error') + ': ' + String(error?.message || ''));
    }
  };
  const browse = async (more = false) => {
    setCatalogBusy(true);
    try {
      const result = await api.getMcpCatalog(search, more ? next || '' : '');
      setCatalog(more ? [...catalog, ...result.items] : result.items);
      setNext(result.next_cursor);
    } catch {
      toast.error(t('mcp.error'));
    } finally {
      setCatalogBusy(false);
    }
  };
  const pick = (item: api.CatalogItem) => {
    const allowed = query.data?.servers.find((value) => value.url === item.url);
    setServer(allowed ? String(allowed.id) : 'custom');
    setUrl(item.url);
    setName(item.name);
    setToken('');
  };
  if (query.isPending) return <div role="status">{t('common.loading')}</div>;
  if (query.isError)
    return (
      <div role="alert">
        {t('mcp.error')}{' '}
        <button className={s.cancelBtn} onClick={() => void query.refetch()}>
          {t('mcp.refresh')}
        </button>
      </div>
    );
  const data = query.data!,
    busy = mutation.isPending;
  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>MCP</div>
      <p className={s.connectionsHelp}>{t('mcp.help')}</p>
      {!data.policy.enabled && <p role="status">{t('mcp.disabled')}</p>}
      {data.connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          busy={busy}
          run={run}
          authorize={async () => {
            setAuthorization('');
            await run(async () => {
              const result = await api.authorizeMcp(connection.id);
              setAuthorization(result.authorization_url);
            });
          }}
        />
      ))}
      {authorization && (
        <div className={s.macroCard}>
          <a href={authorization} target="_blank" rel="noopener noreferrer">
            {t('mcp.openAuthorization')}
          </a>
          <p>{t('mcp.afterAuthorization')}</p>
          <button className={s.cancelBtn} onClick={() => void query.refetch()}>
            {t('mcp.refresh')}
          </button>
        </div>
      )}
      {data.policy.enabled && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api.saveMcpConnection({
                name,
                url,
                server_id: server === 'custom' ? null : Number(server),
                mode,
                timeout_seconds: timeout,
                ...(token ? { token } : {}),
              });
              setName('');
              setUrl('');
              setToken('');
              setServer('');
            });
          }}
        >
          <h3>{t('mcp.add')}</h3>
          <label>
            {t('mcp.server')}
            <Select
              value={server}
              disabled={busy}
              options={[
                ...data.servers.map((item) => ({
                  value: String(item.id),
                  label: item.name,
                  hint: item.description,
                  badge: item.recommended
                    ? { text: t('mcp.recommended'), color: 'success' as const }
                    : undefined,
                })),
                ...(data.policy.allow_custom ? [{ value: 'custom', label: t('mcp.custom') }] : []),
              ]}
              onChange={(value) => {
                setServer(value);
                const item = data.servers.find((item) => String(item.id) === value);
                setName(item?.name || '');
                setUrl(item?.url || '');
              }}
            />
          </label>
          {server === 'custom' && (
            <label>
              URL
              <input
                className={s.fieldInput}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://example.com/mcp"
              />
            </label>
          )}
          <label>
            {t('mcp.name')}
            <input
              className={s.fieldInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </label>
          <label>
            {t('mcp.token')}
            <input
              className={s.fieldInput}
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label>
            {t('mcp.mode')}
            <Select
              value={mode}
              onChange={setMode}
              options={[
                { value: 'search', label: t('mcp.searchMode') },
                { value: 'eager', label: t('mcp.eagerMode') },
              ]}
            />
          </label>
          <label>
            {t('mcp.timeout')}
            <input
              className={s.fieldInput}
              type="number"
              min={10}
              max={3600}
              value={timeout}
              onChange={(e) => setTimeoutValue(Number(e.target.value))}
            />
          </label>
          <button className={s.saveBtn} disabled={busy || !server} type="submit">
            {t('mcp.add')}
          </button>
        </form>
      )}
      {data.policy.enabled && (
        <section className={styles.catalog}>
          <h3>{t('mcp.catalog')}</h3>
          <p className={s.connectionsHelp}>{t('mcp.catalogHelp')}</p>
          <form
            className={styles.search}
            onSubmit={(e) => {
              e.preventDefault();
              void browse();
            }}
          >
            <input
              aria-label={t('mcp.search')}
              className={s.fieldInput}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('mcp.search')}
            />
            <button className={s.cancelBtn} disabled={catalogBusy}>
              {t('mcp.search')}
            </button>
          </form>
          {catalog.map((item, index) => (
            <div className={s.macroCard} key={item.url + index}>
              <strong>{item.name}</strong>
              <p>{item.description}</p>
              <small className={styles.url}>{item.url}</small>
              <button
                className={s.cancelBtn}
                disabled={
                  busy ||
                  (!data.policy.allow_custom &&
                    !data.servers.some((server) => server.url === item.url))
                }
                onClick={() => pick(item)}
              >
                {t('mcp.select')}
              </button>
            </div>
          ))}
          {next && (
            <button
              className={s.cancelBtn}
              disabled={catalogBusy}
              onClick={() => void browse(true)}
            >
              {t('mcp.more')}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
function ConnectionCard({
  connection: c,
  busy,
  run,
  authorize,
}: {
  connection: api.McpConnection;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  authorize: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [token, setToken] = useState(''),
    [timeout, setTimeoutValue] = useState(c.timeout_seconds);
  const save = (body: Record<string, unknown>) => run(() => api.saveMcpConnection(body, c.id));
  return (
    <section className={s.macroCard}>
      <div className={s.macroHeader}>
        <strong>{c.name}</strong>
        <Checkbox
          label={t('mcp.connectionEnabled')}
          checked={!!c.enabled}
          disabled={busy || c.blocked}
          onChange={(enabled) => void save({ enabled })}
        />
      </div>
      <p className={styles.url}>{c.url}</p>
      {c.blocked && <p>{t('mcp.blocked')}</p>}
      <div className={styles.actions}>
        <button
          className={s.cancelBtn}
          disabled={busy || c.blocked || !c.enabled}
          onClick={() => void run(() => api.refreshMcpTools(c.id))}
        >
          {t('mcp.refresh')}
        </button>
        <button
          className={s.cancelBtn}
          disabled={busy || c.blocked || !c.enabled}
          onClick={() => void authorize()}
        >
          {t('mcp.authorize')}
        </button>
        <button className={s.cancelBtn} onClick={() => void run(() => api.cancelMcp(c.id))}>
          {t('mcp.cancelOperation')}
        </button>
        <button
          className={s.cancelBtn}
          disabled={busy}
          onClick={() => void run(() => api.deleteMcpConnection(c.id))}
        >
          {t('mcp.remove')}
        </button>
      </div>
      <details>
        <summary>{t('mcp.settings')}</summary>
        <div className={styles.form}>
          <label>
            {t('mcp.mode')}
            <Select
              value={c.mode}
              disabled={busy || c.blocked}
              onChange={(mode) => void save({ mode })}
              options={[
                { value: 'search', label: t('mcp.searchMode') },
                { value: 'eager', label: t('mcp.eagerMode') },
              ]}
            />
          </label>
          <label>
            {t('mcp.timeout')}
            <input
              type="number"
              className={s.fieldInput}
              value={timeout}
              min={10}
              max={3600}
              onChange={(e) => setTimeoutValue(Number(e.target.value))}
            />
          </label>
          <button
            className={s.cancelBtn}
            disabled={busy || c.blocked}
            onClick={() => void save({ timeout_seconds: timeout })}
          >
            {t('mcp.save')}
          </button>
          <label>
            {t('mcp.replaceToken')}
            <input
              type="password"
              className={s.fieldInput}
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button
            className={s.cancelBtn}
            disabled={busy || !token || c.blocked}
            onClick={() =>
              void run(async () => {
                await api.saveMcpConnection({ token }, c.id);
                setToken('');
              })
            }
          >
            {t('mcp.save')}
          </button>
          {c.has_credentials && (
            <button
              className={s.cancelBtn}
              disabled={busy || c.blocked}
              onClick={() => void save({ token: '' })}
            >
              {t('mcp.clearCredentials')}
            </button>
          )}
        </div>
        <h4>
          {t('mcp.tools')} · {c.tools.length}
        </h4>
        <div className={styles.actions}>
          <button
            className={s.cancelBtn}
            disabled={busy || c.blocked}
            onClick={() => void save({ selected_tools: null })}
          >
            {t('mcp.allTools')}
          </button>
          <button
            className={s.cancelBtn}
            disabled={busy || c.blocked}
            onClick={() => void save({ selected_tools: [] })}
          >
            {t('mcp.noTools')}
          </button>
        </div>
        {!c.tools.length && <p>{t('mcp.refreshHelp')}</p>}
        {c.tools.map((tool) => (
          <div className={styles.tool} key={tool.name}>
            <Checkbox
              checked={c.selected_tools === null || c.selected_tools.includes(tool.name)}
              label={tool.name}
              disabled={busy || c.blocked}
              onChange={(checked) => {
                const selected = new Set(c.selected_tools ?? c.tools.map((tool) => tool.name));
                if (checked) selected.add(tool.name);
                else selected.delete(tool.name);
                void save({ selected_tools: [...selected] });
              }}
            />
            <small>{tool.description}</small>
          </div>
        ))}
      </details>
    </section>
  );
}
