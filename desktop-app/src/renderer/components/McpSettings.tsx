import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useLocalMcp, useMcp, useMcpCatalog } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import { getApiErrorMessage } from '../lib/api';
import { LocalMcpPanel } from './LocalMcpPanel';
import { LocalMcpForm } from './LocalMcpForm';
import {
  emptyMcpApproval,
  packageFromSource,
  localMcpInputSource,
  normalizeMcpEndpoint,
  resolveLocalInput,
  type LocalMcpInstallPhase,
} from '../../main/local-mcp-spec';
import { Select } from './Select';
import { McpToggle, McpTools } from './McpControls';
import { Icon } from './Icon';
import { AnimatedCollapse, AnimatedDetails } from './AnimatedDisclosure';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function McpSettings({
  onAskMcpHelp,
}: {
  onAskMcpHelp?: (message: string) => Promise<void>;
} = {}) {
  const { t } = useTranslation(),
    { query, mutation } = useMcp();
  const { query: localQuery } = useLocalMcp();
  const [reuseExisting, setReuseExisting] = useState(false);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [view, setView] = useState<'catalog' | 'connections'>('catalog');
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState('auto');
  const [directInstall, setDirectInstall] = useState<{
    item: api.CatalogItem;
    phase: LocalMcpInstallPhase;
  } | null>(null);
  const [server, setServer] = useState(''),
    [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [token, setToken] = useState('');
  const [mode, setMode] = useState('search'),
    [timeout, setTimeoutValue] = useState(300);
  const [localDraft, setLocalDraft] = useState<api.CatalogItem | null>(null);
  const [search, setSearch] = useState('');
  const [catalogSearch, setCatalogSearch] = useState<string | null>(null);
  const canSearchRegistry = !!(
    query.data?.policy.enabled &&
    query.data?.policy.show_catalog &&
    query.data?.policy.allow_custom
  );
  const registry = useMcpCatalog(catalogSearch, canSearchRegistry);
  useEffect(() => {
    if (!canSearchRegistry) setCatalogSearch(null);
  }, [canSearchRegistry]);
  const [authorization, setAuthorization] = useState<{ connectionId: number; url: string } | null>(
    null,
  );
  useEffect(() => {
    const policy = query.data?.policy;
    const selected = query.data?.servers.find((item) => String(item.id) === server);
    if (!policy?.show_catalog) setSearch('');
    if (
      !policy?.enabled ||
      (server === 'custom' && !policy.allow_custom) ||
      (server &&
        server !== 'custom' &&
        (!policy.show_catalog ||
          !selected ||
          selected.transport === 'stdio' ||
          selected.url !== url))
    ) {
      setServer('');
      setName('');
      setUrl('');
      setToken('');
    }
  }, [query.data, server, url]);

  useEffect(() => {
    if (query.data && (!query.data.policy.enabled || !query.data.policy.show_catalog))
      setView('connections');
  }, [query.data?.policy.enabled, query.data?.policy.show_catalog]);

  useEffect(() => {
    if (view !== 'connections' || !jumpTo) return;
    const card = document.getElementById(jumpTo);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest' });
    setJumpTo(null);
  }, [view, jumpTo]);

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
      const code = String(error?.code || error?.message || '');
      toast.error(
        t('mcp.error') +
          ': ' +
          getApiErrorMessage(
            error,
            t('mcp.errors.' + code, { defaultValue: code || t('mcp.error') }),
          ),
      );
    }
  };
  const authorizeConnection = async (id: number) => {
    setAuthorization(null);
    const result = await api.authorizeMcp(id);
    setAuthorization({ connectionId: id, url: result.authorization_url });
  };
  const addConnection = (oauth = false) =>
    run(async () => {
      const result = await api.saveMcpConnection({
        name,
        url,
        server_id: server === 'custom' ? null : Number(server),
        reuse_existing: reuseExisting,
        mode,
        timeout_seconds: timeout,
        ...(token ? { token } : {}),
      });
      // Creation succeeded even if the following sign-in needs provider setup.
      // Close the form to prevent accidentally creating the same connection twice.
      setName('');
      setUrl('');
      setToken('');
      setServer('');
      setAdding(false);
      if (oauth) await authorizeConnection(result.connection.id);
    });
  const pick = (item: api.CatalogItem, allowDuplicate = false) => {
    setReuseExisting(!allowDuplicate);
    setAdding(true);
    setAddType('remote');
    setLocalDraft(null);
    setView('connections');
    const approved = query.data?.servers.find((server) => server.url === item.url);
    setServer(approved ? String(approved.id) : 'custom');
    setUrl(item.url);
    setName(item.name);
    setToken('');
  };
  const openLocal = (item: api.CatalogItem, allowDuplicate = false) => {
    setReuseExisting(!allowDuplicate);
    setLocalDraft(item);
    setView('connections');
    setAdding(false);
  };
  const showConnection = (target: string) => {
    setView('connections');
    setAdding(false);
    setLocalDraft(null);
    setJumpTo(target);
  };
  const installFromCatalog = (item: api.CatalogItem) => {
    if (!item.recommended) {
      openLocal(item);
      return;
    }
    const input = {
      name: item.title || item.name,
      description: item.description,
      catalog_id: item.id,
      reuse_existing: true,
      ...(item.package ? { package: item.package } : { source: item.source }),
    };
    try {
      resolveLocalInput(input);
    } catch {
      // The same form handles credentials and any other required values.
      openLocal(item);
      return;
    }
    setDirectInstall({ item, phase: 'installing' });
    void run(async () => {
      const installed = await api.installLocalMcp(input, (phase) =>
        setDirectInstall({ item, phase }),
      );
      showConnection('mcp-local-' + installed.id);
    }).finally(() => setDirectInstall(null));
  };
  if (query.isPending || query.isError)
    return (
      <div className={s.panel}>
        <div className={s.panelTitle}>MCP</div>
        <p className={s.connectionsHelp}>{t('mcp.design.intro')}</p>
        <div className={styles.empty} role={query.isError ? 'alert' : 'status'}>
          {t(query.isError ? 'mcp.error' : 'common.loading')}
          {query.isError && (
            <div className={styles.actions}>
              <button className={s.cancelBtn} onClick={() => void query.refetch()}>
                {t('mcp.refresh')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  const data = query.data!,
    busy = mutation.isPending;
  const canAddLocal =
    data.policy.allow_custom && typeof window.electronAPI?.localMcpManage === 'function';
  const autoAdding = adding && addType === 'auto' && canAddLocal;
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const approvedCatalog = data.servers.filter((item) =>
    words.every((word) =>
      (item.name + ' ' + item.description + ' ' + item.url).toLowerCase().includes(word),
    ),
  );
  const catalog: api.CatalogItem[] =
    canSearchRegistry && catalogSearch !== null
      ? [
          ...new Map(
            (registry.data?.pages.flatMap((page) => page.items) || []).map((item) => [
              item.name + '\n' + (item.package?.identifier || item.url),
              item,
            ]),
          ).values(),
        ]
      : approvedCatalog;
  const showingRegistry = canSearchRegistry && catalogSearch !== null;
  const catalogActions = (item: api.CatalogItem) => {
    const local = !!(item.package || item.source);
    const source = local ? localMcpInputSource(item) : undefined;
    const endpoint = local ? undefined : normalizeMcpEndpoint(item.url);
    const matches = local
      ? (localQuery.data || [])
          .filter((row) => source && row.source_key === source.key)
          .map((row) => ({
            id: 'mcp-local-' + row.id,
            name: row.name,
            installedVersion: row.installed_version,
            localId: row.updatable ? row.id : undefined,
          }))
      : data.connections
          .filter(
            (row) =>
              row.transport !== 'stdio' && endpoint && normalizeMcpEndpoint(row.url) === endpoint,
          )
          .map((row) => ({
            id: 'mcp-remote-' + row.id,
            name: row.name,
            installedVersion: undefined,
            localId: undefined,
          }));
    const disabled = busy || (local && !canAddLocal);
    if (!matches.length)
      return (
        <button
          className={s.cancelBtn}
          disabled={disabled}
          onClick={() => (local ? installFromCatalog(item) : pick(item))}
        >
          {t(
            directInstall?.item === item
              ? 'mcp.local.' + directInstall.phase
              : local
                ? 'mcp.local.install'
                : 'mcp.connect',
          )}
        </button>
      );
    const openButton = (entry: (typeof matches)[number], showName = false) => (
      <button className={s.cancelBtn} onClick={() => showConnection(entry.id)}>
        {showName ? entry.name : t('mcp.catalogConnection.open')}
      </button>
    );
    const updateButton = (entry: (typeof matches)[number]) => {
      const version = source?.version;
      if (
        !version ||
        !/^(?:v)?[0-9]/.test(version) ||
        !entry.localId ||
        entry.installedVersion === version
      )
        return null;
      return (
        <button
          className={s.cancelBtn}
          disabled={disabled}
          onClick={() => {
            setDirectInstall({ item, phase: 'installing' });
            void run(async () => {
              await api.updateLocalMcp(
                entry.localId!,
                (phase) => setDirectInstall({ item, phase }),
                version,
              );
              showConnection(entry.id);
            }).finally(() => setDirectInstall(null));
          }}
        >
          {directInstall?.item === item
            ? t('mcp.local.' + directInstall.phase)
            : t('mcp.catalogConnection.version', { version })}
        </button>
      );
    };
    return (
      <div className={styles.actions}>
        {matches.length === 1 ? (
          <>
            {openButton(matches[0])}
            {matches[0].installedVersion && (
              <small className={s.connectionsHelp}>
                {t('mcp.catalogConnection.installed', { version: matches[0].installedVersion })}
              </small>
            )}
            {updateButton(matches[0])}
          </>
        ) : (
          <AnimatedDetails className={styles.details} summary={t('mcp.catalogConnection.open')}>
            {matches.map((entry) => (
              <div className={styles.actions} key={entry.id}>
                {openButton(entry, true)}
                {updateButton(entry)}
              </div>
            ))}
          </AnimatedDetails>
        )}
        <button
          className={s.cancelBtn}
          disabled={disabled}
          onClick={() => (local ? openLocal(item, true) : pick(item, true))}
        >
          {t('mcp.catalogConnection.addAnother')}
        </button>
      </div>
    );
  };
  return (
    <div className={s.panel}>
      <div className={s.panelTitle}>MCP</div>
      <p className={s.connectionsHelp}>{t('mcp.design.intro')}</p>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="group" aria-label="MCP">
          {data.policy.enabled && data.policy.show_catalog && (
            <button
              type="button"
              aria-pressed={view === 'catalog'}
              onClick={() => setView('catalog')}
            >
              {t('mcp.catalog')}
            </button>
          )}
          <button
            type="button"
            aria-pressed={view === 'connections'}
            onClick={() => setView('connections')}
          >
            {t('mcp.design.connected')}
          </button>
        </div>
        {data.policy.enabled && (data.policy.allow_custom || data.policy.show_catalog) && (
          <button
            className={s.saveBtn}
            aria-expanded={view === 'connections' && (adding || !!localDraft)}
            onClick={() => {
              const open = view !== 'connections' || !(adding || localDraft);
              setView('connections');
              setLocalDraft(null);
              setAdding(open);
              if (open) {
                setAddType(data.policy.allow_custom ? 'auto' : 'remote');
                setReuseExisting(false);
                setServer('');
                setName('');
                setUrl('');
                setToken('');
              }
            }}
          >
            {t(
              (adding || localDraft) && view === 'connections'
                ? 'mcp.cancel'
                : 'mcp.design.addCustom',
            )}
          </button>
        )}
      </div>
      <div hidden={view !== 'connections'}>
        <AnimatedCollapse
          open={
            (adding || !!localDraft) &&
            data.policy.enabled &&
            (data.policy.allow_custom || data.policy.show_catalog)
          }
        >
          <div className={styles.addPanel}>
            {autoAdding && view === 'connections' && (
              <GithubMcpImport
                canAddLocal={canAddLocal}
                allowRegistry={canSearchRegistry}
                onPick={(item) => (item.package || item.source ? openLocal(item) : pick(item))}
                onManual={() => setAddType(canAddLocal ? 'local' : 'remote')}
                onAskMcpHelp={onAskMcpHelp}
              />
            )}
            {adding && !autoAdding && (
              <div className={styles.addType}>
                <Select
                  value={
                    addType === 'auto' || (addType === 'local' && !canAddLocal) ? 'remote' : addType
                  }
                  onChange={setAddType}
                  options={[
                    { value: 'remote', label: t('mcp.design.remote') },
                    ...(canAddLocal ? [{ value: 'local', label: t('mcp.design.local') }] : []),
                  ]}
                />
              </div>
            )}
            {canAddLocal && (localDraft || (adding && addType === 'local')) && (
              <LocalMcpForm
                draft={localDraft}
                reuseExisting={reuseExisting}
                onClose={() => {
                  setLocalDraft(null);
                  setAdding(false);
                }}
                onAskMcpHelp={onAskMcpHelp}
              />
            )}
            {adding &&
              !autoAdding &&
              !localDraft &&
              (addType !== 'local' || !canAddLocal) &&
              data.policy.enabled &&
              (data.policy.show_catalog || data.policy.allow_custom) && (
                <form
                  className={styles.form}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addConnection();
                  }}
                >
                  <h3>{t('mcp.add')}</h3>
                  <label>
                    {t('mcp.server')}
                    <Select
                      value={server}
                      disabled={busy}
                      options={[
                        ...(data.policy.show_catalog
                          ? data.servers.filter((item) => item.transport !== 'stdio')
                          : []
                        ).map((item) => ({
                          value: String(item.id),
                          label: item.name,
                          hint: item.description,
                        })),
                        ...(data.policy.allow_custom
                          ? [{ value: 'custom', label: t('mcp.custom') }]
                          : []),
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
                  <div className={styles.actions}>
                    <button className={s.saveBtn} disabled={busy || !server} type="submit">
                      {t('mcp.add')}
                    </button>
                    <button
                      className={s.cancelBtn}
                      disabled={busy || !server || !!token.trim()}
                      type="button"
                      onClick={() => void addConnection(true)}
                    >
                      {t('mcp.addWithOAuth')}
                    </button>
                  </div>
                </form>
              )}
          </div>
        </AnimatedCollapse>
        {!data.connections.length && (
          <p className={styles.empty}>{t('mcp.design.emptyConnections')}</p>
        )}
        {!data.policy.enabled && (
          <p className={styles.empty} role="status">
            {t('mcp.disabled')}
          </p>
        )}
        {data.connections
          .filter((connection) => connection.transport !== 'stdio')
          .map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              busy={busy}
              run={run}
              authorize={() => run(() => authorizeConnection(connection.id))}
              authorizationUrl={
                authorization?.connectionId === connection.id ? authorization.url : undefined
              }
              onDismissAuthorization={() => setAuthorization(null)}
              onRefreshAuthorization={() => void query.refetch()}
            />
          ))}
        <LocalMcpPanel allowed={data.policy.enabled && data.policy.allow_custom} />
      </div>
      <div hidden={view !== 'catalog'}>
        {data.policy.enabled && data.policy.show_catalog && (
          <section className={styles.catalog}>
            <p className={s.connectionsHelp}>
              {t(canSearchRegistry ? 'mcp.registryHelp' : 'mcp.catalogHelp')}
            </p>
            <form
              className={styles.search}
              onSubmit={(e) => {
                e.preventDefault();
                if (canSearchRegistry && (!search.trim() || search.trim().length >= 3))
                  setCatalogSearch(search.trim());
              }}
            >
              <input
                aria-label={t('mcp.search')}
                className={s.fieldInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('mcp.search')}
              />
              {canSearchRegistry && (
                <button
                  className={s.cancelBtn}
                  disabled={registry.isFetching || (!!search.trim() && search.trim().length < 3)}
                >
                  {t('mcp.search')}
                </button>
              )}
            </form>
            {showingRegistry && registry.isPending && (
              <p className={styles.empty} role="status">
                {t('common.loading')}
              </p>
            )}
            {showingRegistry && registry.isError && (
              <p className={styles.empty} role="alert">
                {t('mcp.error')}
              </p>
            )}
            {!catalog.length && !(showingRegistry && (registry.isPending || registry.isError)) && (
              <p className={styles.empty} role="status">
                {t(showingRegistry ? 'mcp.noRegistryServers' : 'mcp.noApprovedServers')}
              </p>
            )}
            {[
              {
                title: t('mcp.design.recommended'),
                items: approvedCatalog.filter((item) => item.recommended) as api.CatalogItem[],
              },
              { title: t('mcp.catalog'), items: catalog.filter((item) => !item.recommended) },
            ]
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <section key={group.title}>
                  <h3>{group.title}</h3>
                  <div className={styles.cards}>
                    {group.items.map((item) => (
                      <div
                        className={styles.catalogCard}
                        key={(item.package?.identifier || item.url) + ' ' + item.name}
                      >
                        <div className={styles.cardHeading}>
                          <span className={styles.icon}>
                            <Icon name={item.package || item.source ? 'monitor' : 'globe'} />
                          </span>
                          <strong>{item.title || item.name}</strong>
                          {Boolean(item.recommended) && (
                            <span className={styles.badge}>{t('mcp.design.recommendedBadge')}</span>
                          )}
                        </div>
                        <span className={styles.meta}>
                          {t(
                            item.package || item.source ? 'mcp.design.local' : 'mcp.design.remote',
                          )}
                        </span>
                        {item.title && item.title !== item.name && (
                          <p className={styles.url}>{item.name}</p>
                        )}
                        <p>{item.description}</p>
                        <AnimatedDetails
                          className={styles.details}
                          summary={
                            <>
                              <Icon name="code" size={14} />
                              {t('mcp.design.details')}
                            </>
                          }
                        >
                          <div className={styles.detailBody}>
                            <dl className={styles.metadata}>
                              {item.url && (
                                <>
                                  <dt>URL</dt>
                                  <dd>
                                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                                      {item.url}
                                    </a>
                                  </dd>
                                </>
                              )}
                              {item.package && (
                                <>
                                  <dt>{item.package.registryType === 'pypi' ? 'PyPI' : 'npm'}</dt>
                                  <dd>{item.package.identifier}</dd>
                                </>
                              )}
                              {item.publisher && (
                                <>
                                  <dt>{t('mcp.publisher')}</dt>
                                  <dd>{item.publisher}</dd>
                                </>
                              )}
                              {item.version && (
                                <>
                                  <dt>{t('mcp.version')}</dt>
                                  <dd>{item.version}</dd>
                                </>
                              )}
                            </dl>
                            {item.source && <pre className={styles.source}>{item.source}</pre>}
                            <div className={styles.links}>
                              {[
                                {
                                  url: item.repository_url,
                                  label: t('mcp.repository'),
                                  icon: 'code',
                                },
                                { url: item.website_url, label: t('mcp.website'), icon: 'globe' },
                                {
                                  url: item.registry_url,
                                  label: t('mcp.registryEntry'),
                                  icon: 'book',
                                },
                              ]
                                .filter((link) => link.url)
                                .map((link) => (
                                  <a
                                    key={link.label}
                                    href={link.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <Icon name={link.icon} size={14} />
                                    {link.label}
                                    <span aria-hidden="true">↗</span>
                                  </a>
                                ))}
                            </div>
                          </div>
                        </AnimatedDetails>
                        {catalogActions(item)}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            {showingRegistry && registry.hasNextPage && (
              <button
                className={s.cancelBtn}
                disabled={registry.isFetching || search.trim() !== catalogSearch}
                onClick={() => void registry.fetchNextPage()}
              >
                {t('mcp.more')}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
function GithubMcpImport({
  canAddLocal,
  allowRegistry,
  onPick,
  onManual,
  onAskMcpHelp,
}: {
  canAddLocal: boolean;
  allowRegistry: boolean;
  onPick: (item: api.CatalogItem) => void;
  onManual: () => void;
  onAskMcpHelp?: (message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [link, setLink] = useState('');
  const [items, setItems] = useState<api.CatalogItem[]>([]);
  const [status, setStatus] = useState<
    'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'invalidUrl' | 'invalidManifest'
  >('idle');
  const failed =
    status === 'empty' ||
    status === 'error' ||
    status === 'invalidUrl' ||
    status === 'invalidManifest';
  const [asking, setAsking] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading');
    try {
      const result = await api.importGithubMcp(link.trim(), allowRegistry, controller.signal);
      if (controller.signal.aborted) return;
      const supported = result.items.filter((item) => {
        if (!item.package) return !!item.url || (canAddLocal && !!item.source);
        if (!canAddLocal || !packageFromSource(JSON.stringify({ package: item.package })))
          return false;
        try {
          resolveLocalInput({ package: item.package });
          return true;
        } catch (error) {
          return error instanceof Error && error.message === 'mcp_required_configuration';
        }
      });
      if (supported.length === 1) {
        onPick(supported[0]);
      } else {
        setItems(supported);
        setStatus(supported.length ? 'ready' : 'empty');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : '';
      setStatus(
        message.includes('mcp_invalid_github_url')
          ? 'invalidUrl'
          : message.includes('mcp_invalid_manifest')
            ? 'invalidManifest'
            : 'error',
      );
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (status !== 'loading' && link.trim()) void load();
      }}
    >
      <label>
        {t('mcp.github.repository')}
        <input
          className={s.fieldInput}
          type="url"
          required
          maxLength={2048}
          value={link}
          onChange={(event) => {
            request.current?.abort();
            setLink(event.target.value);
            setItems([]);
            setStatus('idle');
          }}
          placeholder="https://github.com/owner/repository"
        />
      </label>
      <p className={s.connectionsHelp}>
        {t('mcp.github.hint')} <code>uvx windows-mcp serve</code>
      </p>
      {failed && (
        <p className={s.connectionsHelp} role="status">
          {t('mcp.github.' + status)}
        </p>
      )}
      {status === 'ready' &&
        items.map((item) => (
          <button
            key={
              item.package
                ? item.package.registryType + ':' + item.package.identifier + '@' + item.version
                : item.url || item.source
            }
            type="button"
            className={s.cancelBtn}
            onClick={() => onPick(item)}
          >
            {item.package
              ? [item.package.identifier, item.version].filter(Boolean).join(' · ')
              : item.url || item.source || item.title || item.name}
          </button>
        ))}
      <div className={styles.actions}>
        <button className={s.saveBtn} type="submit" disabled={status === 'loading' || !link.trim()}>
          {t(status === 'loading' ? 'mcp.github.loading' : 'mcp.github.load')}
        </button>
        <button className={s.cancelBtn} type="button" onClick={onManual}>
          {t('mcp.github.manual')}
        </button>
        {onAskMcpHelp && (
          <button
            className={s.cancelBtn}
            type="button"
            disabled={asking || !link.trim()}
            onClick={() => {
              setAsking(true);
              void onAskMcpHelp(t('mcp.github.prompt') + '\n' + link.trim()).finally(() =>
                setAsking(false),
              );
            }}
          >
            {t('mcp.github.ask')}
          </button>
        )}
      </div>
    </form>
  );
}

function ConnectionCard({
  connection: c,
  busy,
  run,
  authorize,
  authorizationUrl,
  onDismissAuthorization,
  onRefreshAuthorization,
}: {
  connection: api.McpConnection;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  authorize: () => Promise<void>;
  authorizationUrl?: string;
  onDismissAuthorization: () => void;
  onRefreshAuthorization: () => void;
}) {
  const { t } = useTranslation();
  const [remove, setRemove] = useState(false);
  const [token, setToken] = useState(''),
    [timeout, setTimeoutValue] = useState(c.timeout_seconds);
  const save = (body: Record<string, unknown>) => run(() => api.saveMcpConnection(body, c.id));
  const approval = c.approval_policy || emptyMcpApproval();
  const saveApproval = (patch: Partial<typeof approval>) =>
    save({ approval_policy: { ...approval, ...patch } });
  return (
    <section className={styles.connection} id={'mcp-remote-' + c.id} tabIndex={-1}>
      <div className={styles.cardHeading}>
        <span className={styles.icon}>
          <Icon name="globe" />
        </span>
        <strong>{c.name}</strong>
        <McpToggle
          label={t('mcp.connectionEnabled')}
          checked={!!c.enabled}
          disabled={busy || c.blocked}
          onChange={(enabled) => void save({ enabled })}
        />
      </div>
      <p className={styles.url}>
        <a href={c.url} target="_blank" rel="noopener noreferrer">
          {c.url}
        </a>
      </p>
      <p className={styles.url}>
        {c.capabilities
          ? [
              c.capabilities.tools ? t('mcp.tools') + ': ' + c.tools.length : '',
              c.capabilities.resources
                ? t('mcp.resources') +
                  ': ' +
                  (c.resources?.length || 0) +
                  ' · ' +
                  t('mcp.resourceTemplates') +
                  ': ' +
                  (c.resource_templates?.length || 0)
                : '',
            ]
              .filter(Boolean)
              .join(' · ') || t('mcp.noSupportedCapabilities')
          : t('mcp.metadataUnknown')}
      </p>
      {c.blocked && <p>{t('mcp.blocked')}</p>}
      <div className={styles.actions}>
        <button
          className={s.cancelBtn}
          disabled={busy || c.blocked || !c.enabled}
          onClick={() => void run(() => api.refreshMcpTools(c.id))}
        >
          {t('mcp.refresh')}
        </button>

        <button className={s.cancelBtn} onClick={() => void run(() => api.cancelMcp(c.id))}>
          {t('mcp.cancelOperation')}
        </button>
      </div>
      <AnimatedCollapse open={!!authorizationUrl}>
        {authorizationUrl && (
          <section className={styles.authorization} aria-label={t('mcp.design.oauthTitle')}>
            <div className={styles.authorizationHeading}>
              <span className={styles.icon}>
                <Icon name="lock" />
              </span>
              <div>
                <h4>{t('mcp.design.oauthTitle')}</h4>
                <p>{t('mcp.afterAuthorization')}</p>
              </div>
              <button
                type="button"
                className={styles.dismiss}
                aria-label={t('common.close')}
                onClick={onDismissAuthorization}
              >
                ×
              </button>
            </div>
            <div className={styles.authorizationActions}>
              <a
                className={`${s.saveBtn} ${styles.authorizationLink}`}
                href={authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('mcp.openAuthorization')}
                <span aria-hidden="true">↗</span>
              </a>
              <button
                type="button"
                className={s.cancelBtn}
                disabled={busy}
                onClick={onRefreshAuthorization}
              >
                {t('mcp.refresh')}
              </button>
            </div>
          </section>
        )}
      </AnimatedCollapse>
      <AnimatedDetails
        className={styles.details}
        summary={
          <>
            <Icon name="key" size={14} />
            {t('mcp.settings')}
          </>
        }
      >
        <div className={styles.detailBody}>
          <McpToggle
            label={t('mcp.approvals.allowAll')}
            hint={t('mcp.approvals.allowAllHint')}
            checked={approval.allow_all}
            disabled={busy || c.blocked}
            onChange={(allow_all) => void saveApproval({ allow_all })}
          />
          {approval.resources.map((uri) => (
            <div className={styles.tool} key={uri}>
              <McpToggle
                label={t('mcp.approvals.alwaysResource') + ': ' + uri}
                checked
                disabled={busy || approval.allow_all}
                onChange={() =>
                  void saveApproval({
                    resources: approval.resources.filter((value) => value !== uri),
                  })
                }
              />
            </div>
          ))}

          <div className={`${styles.settingsForm} ${styles.settingsGrid}`}>
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
          </div>
        </div>
      </AnimatedDetails>
      <AnimatedDetails
        className={styles.details}
        summary={
          <>
            <Icon name="lock" size={14} />
            {t('mcp.design.authorization')}
          </>
        }
      >
        <div className={styles.detailBody}>
          <div className={styles.settingsForm}>
            <div className={styles.actions}>
              <button
                className={s.cancelBtn}
                disabled={busy || c.blocked || !c.enabled}
                onClick={() => void authorize()}
              >
                {t('mcp.authorize')}
              </button>{' '}
            </div>
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
        </div>
      </AnimatedDetails>
      {!!c.capabilities?.resources && (
        <AnimatedDetails
          className={styles.details}
          summary={
            <>
              <Icon name="file" size={14} />
              {t('mcp.resources')} · {c.resources?.length || 0} / {t('mcp.resourceTemplates')} ·{' '}
              {c.resource_templates?.length || 0}
            </>
          }
        >
          <div className={styles.detailBody}>
            <p className={s.connectionsHelp}>{t('mcp.resourcesHelp')}</p>
            {[...(c.resources || []), ...(c.resource_templates || [])].map((resource) => (
              <div className={styles.tool} key={resource.uri || resource.uriTemplate}>
                <strong>{resource.title || resource.name}</strong>
                <p className={styles.url}>{resource.uri || resource.uriTemplate}</p>
                <small>{resource.description}</small>
              </div>
            ))}
          </div>
        </AnimatedDetails>
      )}
      <McpTools
        tools={c.tools}
        selected={c.selected_tools}
        approval={approval}
        disabled={busy || c.blocked}
        saveSelected={(selected_tools) => void save({ selected_tools })}
        saveApproval={(patch) => void saveApproval(patch)}
      />
      <div className={styles.connectionFooter}>
        <button className={styles.removeButton} disabled={busy} onClick={() => setRemove(true)}>
          {t('mcp.remove')}
        </button>
      </div>
      {remove && (
        <ConfirmDialog
          open={remove}
          title={t('mcp.remove')}
          text={c.name}
          confirmDisabled={busy}
          onCancel={() => {
            if (!busy) setRemove(false);
          }}
          onConfirm={() => void run(() => api.deleteMcpConnection(c.id))}
        />
      )}
    </section>
  );
}
