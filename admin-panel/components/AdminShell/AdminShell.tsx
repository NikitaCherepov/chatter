import type { ReactNode } from 'react';
import type { Service } from '../../lib/types';
import { Brand } from '../Brand/Brand';
import { Icon, type IconName } from '../icons/icons';
import styles from './AdminShell.module.css';

export type AdminSection =
  | 'overview'
  | 'users'
  | 'models'
  | 'limits'
  | 'integrations'
  | 'services'
  | 'system'
  | 'logs'
  | 'security';
type NavItem = { id: AdminSection; label: string; icon: IconName };

const primaryItems: NavItem[] = [
  { id: 'overview', label: 'Обзор', icon: 'overview' },
  { id: 'users', label: 'Пользователи', icon: 'users' },
  { id: 'models', label: 'Модели', icon: 'models' },
  { id: 'limits', label: 'Тарифы и лимиты', icon: 'limits' },
  { id: 'integrations', label: 'Интеграции', icon: 'integrations' },
  { id: 'services', label: 'Сервисы', icon: 'services' },
];

const secondaryItems: NavItem[] = [
  { id: 'system', label: 'Система', icon: 'system' },
  { id: 'logs', label: 'Логи', icon: 'logs' },
  { id: 'security', label: 'Безопасность', icon: 'security' },
];

const titles: Record<AdminSection, [string, string]> = {
  overview: ['Обзор', 'Состояние сервера и компонентов Chatter'],
  users: ['Пользователи', 'Аккаунты, роли и привязки'],
  models: ['Модели', 'Провайдер и основная модель'],
  limits: ['Тарифы и лимиты', 'Общие правила и индивидуальные ограничения'],
  integrations: ['Интеграции', 'Внешние API и возможности Chatter'],
  services: ['Сервисы', 'Telegram, Voice и дополнительные компоненты'],
  system: ['Система', 'Сервер, обновления и резервные копии'],
  logs: ['Логи', 'События и ошибки сервисов'],
  security: ['Безопасность', 'Доступ к панели управления'],
};

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
        <nav className={styles.navigation} aria-label="Основная навигация">
          <NavigationItems items={primaryItems} active={section} onSelect={onSectionChange} />
          <div className={styles.divider} />
          <NavigationItems items={secondaryItems} active={section} onSelect={onSectionChange} />
        </nav>
        <div className={styles.account}>
          <span className={styles.avatar}>{username.slice(0, 1).toUpperCase()}</span>
          <span className={styles.username}>{username}</span>
          <button className={styles.logout} type="button" onClick={onLogout} title="Выйти">
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
          <div
            className={`${styles.serverStatus} ${healthy ? styles.serverHealthy : styles.serverProblem}`}
          >
            <span />
            {healthy ? 'Сервер работает' : 'Нужна проверка'}
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
