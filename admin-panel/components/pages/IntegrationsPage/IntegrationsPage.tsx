import type { AdminSection } from '../../AdminShell/AdminShell';
import type { Settings } from '../../../lib/types';
import { Icon } from '../../icons/icons';
import styles from './IntegrationsPage.module.css';

const planned = [
  { name: 'Pinecone', description: 'Векторная память', group: 'Память' },
  {
    name: 'Web Search',
    description: 'Поиск информации в интернете',
    group: 'Интернет',
  },
  {
    name: 'Web Reader',
    description: 'Чтение и обработка веб-страниц',
    group: 'Интернет',
  },
  {
    name: 'Cloud TTS',
    description: 'Облачные голоса и озвучка',
    group: 'Медиа',
  },
];

export function IntegrationsPage({
  settings,
  onNavigate,
}: {
  settings: Settings;
  onNavigate: (section: AdminSection) => void;
}) {
  return (
    <div className={styles.stack}>
      <section className={styles.intro}>
        <div>
          <h2>Подключённые возможности</h2>
          <p>
            Ключи будут разделены по сервисам, чтобы первоначальная настройка оставалась простой.
          </p>
        </div>
      </section>
      <div className={styles.grid}>
        <button type="button" className={styles.card} onClick={() => onNavigate('models')}>
          <span className={styles.icon}>AI</span>
          <span className={styles.info}>
            <small>Модели</small>
            <strong>OpenAI-совместимый API</strong>
            <em>{settings.hasAiApiKey ? 'Подключено' : 'Не настроено'}</em>
          </span>
          <Icon name="arrow" />
        </button>
        {planned.map((item) => (
          <article className={`${styles.card} ${styles.planned}`} key={item.name}>
            <span className={styles.icon}>{item.name.slice(0, 2)}</span>
            <span className={styles.info}>
              <small>{item.group}</small>
              <strong>{item.name}</strong>
              <em>{item.description}</em>
            </span>
            <span className={styles.soon}>позже</span>
          </article>
        ))}
      </div>
    </div>
  );
}
