import styles from './Toggle.module.css';

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={styles.wrap}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.control} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
