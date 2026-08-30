import styles from './Toggle.module.css';

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={styles.wrap}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.control} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
