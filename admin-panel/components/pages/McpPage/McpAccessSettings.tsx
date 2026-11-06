'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Select } from '../../ui/Select/Select';
import { FormField } from '../../ui/FormField/FormField';
import s from './McpPage.module.css';

type User = { id: number; name: string | null; role: string; is_admin: boolean };
type Rule = { mode: 'all' | 'selected' | 'none'; user_ids: number[]; excluded_user_ids: number[] };
type Access = Record<'allow_custom' | 'show_catalog', Rule>;
export function McpAccessSettings() {
  const { t } = useTranslation();
  const [access, setAccess] = useState<Access | null>(null);
  const [saved, setSaved] = useState<Access | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const [settings, accounts] = await Promise.all([
        api<{ access: Access }>('/api/mcp/access'),
        api<{ users: User[] }>('/api/model-access-users'),
      ]);
      setAccess(settings.access);
      setSaved(settings.access);
      setUsers(accounts.users);
    } catch {
      setError(t('mcp.error'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const update = (key: keyof Access, patch: Partial<Rule>) =>
    setAccess((previous) =>
      previous ? { ...previous, [key]: { ...previous[key], ...patch } } : null,
    );
  const save = async (key: keyof Access) => {
    if (!access || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ access: Access }>('/api/mcp/access', {
        method: 'PUT',
        body: JSON.stringify({ [key]: access[key] }),
      });
      setSaved((previous) =>
        previous ? { ...previous, [key]: result.access[key] } : result.access,
      );
      // Saving one permission must not discard edits in the other permission.
      setAccess((previous) =>
        previous ? { ...previous, [key]: result.access[key] } : result.access,
      );
    } catch {
      setError(t('mcp.error'));
    } finally {
      setBusy(false);
    }
  };
  const options = users.map((user) => ({
    value: String(user.id),
    label: user.name || '#' + user.id,
    hint:
      '#' +
      user.id +
      (user.is_admin || user.role === 'admin' ? ' · ' + t('models.access.admin') : ''),
  }));
  return (
    <div className={s.accessGrid}>
      {error && (
        <p className={`${s.status} ${s.wide}`} role="alert">
          {error}{' '}
          <button type="button" disabled={busy} onClick={() => void load()}>
            {t('mcp.refresh')}
          </button>
        </p>
      )}
      {!access && !error && (
        <p className={`${s.status} ${s.wide}`} role="status">
          {t('common.loading')}
        </p>
      )}
      {access &&
        (['allow_custom', 'show_catalog'] as const).map((key) => {
          const rule = access[key];
          const listKey = rule.mode === 'all' ? 'excluded_user_ids' : 'user_ids';
          return (
            <div className={s.accessRule} key={key}>
              <FormField
                label={t(key === 'allow_custom' ? 'mcp.design.customAccess' : 'mcp.showCatalog')}
              >
                <Select
                  value={rule.mode}
                  disabled={busy}
                  aria-label={t(
                    key === 'allow_custom' ? 'mcp.design.customAccess' : 'mcp.showCatalog',
                  )}
                  options={(['all', 'selected', 'none'] as const).map((value) => ({
                    value,
                    label: t('mcp.access.' + value),
                  }))}
                  onChange={(value) => update(key, { mode: value as Rule['mode'] })}
                />
              </FormField>
              {(rule.mode === 'selected' ||
                (rule.mode === 'all' && rule.excluded_user_ids.length > 0)) && (
                <FormField
                  label={t(rule.mode === 'all' ? 'mcp.access.except' : 'models.access.users')}
                >
                  <Select
                    value=""
                    onChange={() => {}}
                    disabled={busy}
                    options={options}
                    selectedValues={rule[listKey].map(String)}
                    onSelectionChange={(values) => update(key, { [listKey]: values.map(Number) })}
                    searchable
                    placeholder={t('models.access.choose')}
                    searchPlaceholder={t('models.access.search')}
                    emptyText={t('models.access.empty')}
                    aria-label={t(
                      key === 'allow_custom' ? 'mcp.access.customUsers' : 'mcp.access.catalogUsers',
                    )}
                  />
                </FormField>
              )}
              <button
                type="button"
                disabled={busy || JSON.stringify(rule) === JSON.stringify(saved?.[key])}
                onClick={() => void save(key)}
              >
                {t('mcp.save')}
              </button>
            </div>
          );
        })}
    </div>
  );
}
