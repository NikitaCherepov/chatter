import styles from './ActionBar.module.css';

export function ActionBar({ saving, state }: { saving: boolean; state: string }) {
  const isError = state.startsWith('Ошибка');
  return (
    <div className={styles.bar}>
      <p className={isError ? styles.error : ''}>{state}</p>
      <button type="submit" disabled={saving}>
        {saving ? 'Применяю…' : 'Сохранить и применить'}
      </button>
    </div>
  );
}
