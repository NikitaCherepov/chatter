import { useTranslation } from 'react-i18next';
import { FormField } from '../../ui/FormField/FormField';
import { SecretState } from '../../ui/SecretState/SecretState';

export function IntegrationSecretField({
  label,
  value,
  configured,
  onChange,
  placeholder,
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
  const { t } = useTranslation();
  return (
    <FormField
      label={label}
      state={<SecretState configured={configured || Boolean(value)} />}
      hint={hint || (configured ? t('integrations.secretField.hint') : undefined)}
    >
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        placeholder={configured ? t('integrations.secretField.placeholderExisting') : (placeholder || t('integrations.secretField.placeholderNew'))}
        required={required && !configured}
      />
    </FormField>
  );
}
