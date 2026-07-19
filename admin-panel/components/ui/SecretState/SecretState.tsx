import styles from './SecretState.module.css';

export function SecretState({ configured }: { configured: boolean }) {
  return (
    <span className={configured ? styles.configured : styles.missing}>
      {configured ? 'сохранён' : 'не задан'}
    </span>
  );
}
