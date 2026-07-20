import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import styles from './SecurityPage.module.css';

type Props = {
  username: string;
  currentPassword: string;
  newPassword: string;
  state: string;
  onUsernameChange: (value: string) => void;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

export function SecurityPage({
  username,
  currentPassword,
  newPassword,
  state,
  onUsernameChange,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <Card
        title={t('security.adminData')}
        description={t('security.reLoginHint')}
      >
        <div className={grid.fields}>
          <FormField label={t('security.usernameLabel')}>
            <input
              value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
              required
            />
          </FormField>
          <FormField label={t('security.currentPassword')}>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => onCurrentPasswordChange(event.target.value)}
              autoComplete="current-password"
              required
            />
          </FormField>
          <FormField label={t('security.newPassword')} hint={t('security.passwordHint')}>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => onNewPasswordChange(event.target.value)}
              minLength={12}
              autoComplete="new-password"
              required
            />
          </FormField>
          <div className={styles.actions}>
            <span>{state}</span>
            <button type="submit">{t('security.changeData')}</button>
          </div>
        </div>
      </Card>
    </form>
  );
}
