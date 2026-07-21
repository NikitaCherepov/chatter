import type { ReactNode } from 'react';
import type { Service } from '../../lib/types';
import { useTranslation } from 'react-i18next';
import { Brand } from '../Brand/Brand';
import { Icon, type IconName } from '../icons/icons';
import { useServerUpdate } from '../../lib/hooks/useServerUpdate';
import styles from './AdminShell.module.css';

export type AdminSection =
  | 'overview'
  | 'users'
  | 'accessKeys'
  | 'models'
  | 'limits'
  | 'integrations'
  | 'services'
  | 'system'
  | 'backups'
  | 'logs'
  | 'security'
  | 'settings';
type NavItem = { id: AdminSection; label: string; icon: IconName };

type Props = {
  section: AdminSection;
  username: string;
  services: Service[];
  children: ReactNode;
  onSectionChange: (section: AdminSection) => void;
  onLogout: () => void;
};

export function AdminShell({
  section,
  username,
  services,
  children,
  onSectionChange,
  onLogout,
}: Props) {
  const { t } = useTranslation();
  const updateQuery = useServerUpdate();
  const updateAvailable = updateQuery.data?.supported && updateQuery.data.available;

  const primaryItems: NavItem[] = [
    { id: 'overview', label: t('nav.overview'), icon: 'overview' },
    { id: 'users', label: t('nav.users'), icon: 'users' },
    { id: 'accessKeys', label: t('nav.accessKeys'), icon: 'security' },
    { id: 'models', label: t('nav.models'), icon: 'models' },
    { id: 'limits', label: t('nav.limits'), icon: 'limits' },
    { id: 'integrations', label: t('nav.integrations'), icon: 'integrations' },
    { id: 'services', label: t('nav.services'), icon: 'services' },
  ];

  const secondaryItems: NavItem[] = [
    { id: 'system', label: t('nav.system'), icon: 'system' },
    { id: 'backups', label: t('nav.backups'), icon: 'backups' },
    { id: 'logs', label: t('nav.logs'), icon: 'logs' },
    { id: 'security', label: t('nav.security'), icon: 'security' },
    { id: 'settings', label: t('nav.settings'), icon: 'settings' },
  ];

  const titles: Record<AdminSection, [string, string]> = {
    overview: [t('nav.overviewTitle'), t('nav.overviewDesc')],
    users: [t('nav.usersTitle'), t('nav.usersDesc')],
    accessKeys: [t('nav.accessKeysTitle'), t('nav.accessKeysDesc')],
    models: [t('nav.modelsTitle'), t('nav.modelsDesc')],
    limits: [t('nav.limitsTitle'), t('nav.limitsDesc')],
    integrations: [t('nav.integrationsTitle'), t('nav.integrationsDesc')],
    services: [t('nav.servicesTitle'), t('nav.servicesDesc')],
    system: [t('nav.systemTitle'), t('nav.systemDesc')],
    backups: [t('nav.backupsTitle'), t('nav.backupsDesc')],
    logs: [t('nav.logsTitle'), t('nav.logsDesc')],
    security: [t('nav.securityTitle'), t('nav.securityDesc')],
    settings: [t('nav.settingsTitle'), t('nav.settingsDesc')],
  };

  const backend = services.find((service) => service.service === 'backend');
  const healthy = backend?.state === 'running' && (!backend.health || backend.health === 'healthy');
  const [title, subtitle] = titles[section];

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brandWrap}>
          <Brand />
          <span className={styles.adminLabel}>Admin</span>
        </div>
        <nav className={styles.navigation} aria-label={t('nav.mainNav')}>
          <NavigationItems items={primaryItems} active={section} onSelect={onSectionChange} />
          <div className={styles.divider} />
          <NavigationItems items={secondaryItems} active={section} onSelect={onSectionChange} />
        </nav>
        <div className={styles.account}>
          <span className={styles.avatar}>{username.slice(0, 1).toUpperCase()}</span>
          <span className={styles.username}>{username}</span>
          <button className={styles.logout} type="button" onClick={onLogout} title={t('nav.logout')}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className={styles.headerStatus}>
            {updateAvailable && (
              <button
                type="button"
                className={styles.updateBadge}
                onClick={() => onSectionChange('system')}
                title={t('nav.updateAvailable')}
              >
                <span />
                {t('nav.updateAvailable')}
              </button>
            )}
            <div
              className={`${styles.serverStatus} ${healthy ? styles.serverHealthy : styles.serverProblem}`}
            >
              <span />
              {healthy ? t('nav.serverHealthy') : t('nav.serverNeedsCheck')}
            </div>
          </div>
        </header>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}

function NavigationItems({
  items,
  active,
  onSelect,
}: {
  items: NavItem[];
  active: AdminSection;
  onSelect: (section: AdminSection) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${styles.navItem} ${active === item.id ? styles.navItemActive : ''}`}
          onClick={() => onSelect(item.id)}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
    </>
  );
}
