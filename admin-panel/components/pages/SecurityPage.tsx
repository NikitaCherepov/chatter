import type { FormEvent } from 'react';
import { Card } from '../ui/Card';
import { FormField } from '../ui/FormField';
import grid from '../ui/PageGrid.module.css';
import styles from './SecurityPage.module.css';

type Props = { username: string; currentPassword: string; newPassword: string; state: string; onUsernameChange: (value: string) => void; onCurrentPasswordChange: (value: string) => void; onNewPasswordChange: (value: string) => void; onSubmit: (event: FormEvent) => void };

export function SecurityPage({ username, currentPassword, newPassword, state, onUsernameChange, onCurrentPasswordChange, onNewPasswordChange, onSubmit }: Props) {
  return <form className={styles.form} onSubmit={onSubmit}><Card title="Данные администратора" description="После изменения потребуется войти в панель заново"><div className={grid.fields}><FormField label="Логин"><input value={username} onChange={(event) => onUsernameChange(event.target.value)} required /></FormField><FormField label="Текущий пароль"><input type="password" value={currentPassword} onChange={(event) => onCurrentPasswordChange(event.target.value)} autoComplete="current-password" required /></FormField><FormField label="Новый пароль" hint="Минимум 12 символов"><input type="password" value={newPassword} onChange={(event) => onNewPasswordChange(event.target.value)} minLength={12} autoComplete="new-password" required /></FormField><div className={styles.actions}><span>{state}</span><button type="submit">Сменить данные</button></div></div></Card></form>;
}
