import { FormField } from '../../ui/FormField/FormField';
import { SecretState } from '../../ui/SecretState/SecretState';

export function IntegrationSecretField({
  label,
  value,
  configured,
  onChange,
  placeholder = 'Вставь API-ключ',
  hint,
  required = false,
}: {
  label: string;
  value: string;
  configured: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <FormField
      label={label}
      state={<SecretState configured={configured || Boolean(value)} />}
      hint={hint || (configured ? 'Оставь пустым, чтобы сохранить текущий ключ' : undefined)}
    >
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        placeholder={configured ? 'Оставь пустым, чтобы не менять' : placeholder}
        required={required && !configured}
      />
    </FormField>
  );
}
