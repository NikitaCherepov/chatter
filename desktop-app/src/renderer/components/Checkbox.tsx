import s from './Checkbox.module.scss';

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
};

export default function Checkbox({ checked, onChange, label, disabled }: Props) {
  return (
    <label className={s.wrap}>
      <input
        type="checkbox"
        className={s.checkbox}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label && <span className={s.label}>{label}</span>}
    </label>
  );
}
