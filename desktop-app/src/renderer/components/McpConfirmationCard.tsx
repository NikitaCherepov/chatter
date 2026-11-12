import { useContext, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmationCard, ConfirmationCardContext } from './ConfirmationCard';
import { RejectWithComment } from './RejectWithComment';
import { Icon } from './Icon';
import { apiFetch, getApiErrorMessage, onMcpOAuthCompleted } from '../lib/api';
import { authorizeMcp, refreshMcpTools, saveMcpConnection } from '../lib/mcp-service';
import { packageFields, packageFromSource } from '../../main/local-mcp-spec';
import s from '../pages/ChatPage.module.scss';
import settingsStyles from './SettingsModal.module.scss';
import styles from './McpConfirmationCard.module.scss';
import activityStyles from './ToolActivity.module.scss';

export type McpConfirmation = {
  confirmation_id: string;
  connection_id?: number;
  server_name: string;
  operation:
    | 'tool'
    | 'resource'
    | 'install'
    | 'install_config'
    | 'authorize'
    | 'config_read'
    | 'config_update';
  phase?: 'installing' | 'connecting';
  target: string;
  arguments: unknown;
};
type Props = Omit<
  ComponentProps<typeof ConfirmationCard>,
  'children' | 'actions' | 'extraActions'
> & {
  confirmation: McpConfirmation;
  onResolved: (id: string) => void;
};
function AllowButton({
  label,
  remember,
  submit,
  disabled,
}: {
  label: string;
  remember?: boolean;
  submit: (approved: boolean, remember?: boolean, comment?: string) => Promise<void>;
  disabled?: boolean;
}) {
  const card = useContext(ConfirmationCardContext);
  return (
    <button
      type="button"
      className={s.suggestMacroSaveBtn}
      disabled={card?.busy || disabled}
      onClick={() => void card?.run(() => submit(true, remember)).catch(() => {})}
    >
      {label}
    </button>
  );
}
export function McpConfirmationCard({ confirmation: conf, onResolved, ...props }: Props) {
  const { t } = useTranslation(),
    [error, setError] = useState(''),
    [installAccepted, setInstallAccepted] = useState(false),
    [token, setToken] = useState(''),
    [oauthUrl, setOAuthUrl] = useState(''),
    [oauthBusy, setOAuthBusy] = useState(false),
    [values, setValues] = useState<Record<string, string>>({});
  const checkingAuthorization = useRef(false);
  const resource = conf.operation === 'resource';
  const localConfiguration = conf.operation === 'install_config';
  const install = conf.operation === 'install' || localConfiguration;
  const authorize = conf.operation === 'authorize' && conf.connection_id !== undefined;
  const source = localConfiguration ? (conf.arguments as { source?: string })?.source : undefined;
  const pkg = source ? packageFromSource(source) : undefined;
  const configured = pkg ? JSON.parse(source!).values : undefined;
  const fields = pkg
    ? packageFields(pkg).filter(
        (field) => field.required && !String(configured?.[field.key] ?? field.default).trim(),
      )
    : [];
  const showError = (error: any) => {
    const code = error?.body?.error || error?.message;
    setError(
      getApiErrorMessage(
        error,
        t('mcp.errors.' + code, { defaultValue: t('chat.toasts.commandApprovalFailed') }),
      ),
    );
  };
  const openOAuth = async () => {
    if (conf.connection_id === undefined) return;
    setOAuthBusy(true);
    setError('');
    try {
      setOAuthUrl((await authorizeMcp(conf.connection_id)).authorization_url);
    } catch (error) {
      showError(error);
    } finally {
      setOAuthBusy(false);
    }
  };
  const submit = async (
    approved: boolean,
    remember = false,
    comment = '',
    oauthVerified = false,
  ) => {
    if (approved && authorize && checkingAuthorization.current) return;
    if (approved && authorize) checkingAuthorization.current = true;
    setError('');
    try {
      if (approved && authorize && !oauthVerified) {
        const id = conf.connection_id!;
        if (token.trim()) {
          await saveMcpConnection({ token: token.trim() }, id);
          setToken('');
        }
        await refreshMcpTools(id);
      }
      const result = await apiFetch<{ status?: string }>('/api/v1/pc-commands/approve', {
        method: 'POST',
        body: JSON.stringify({
          confirmation_id: conf.confirmation_id,
          approved,
          remember_mcp: remember,
          ...(approved && localConfiguration ? { mcp_values: values } : {}),
          ...(comment ? { rejection_comment: comment } : {}),
        }),
      });
      if (result?.status === 'executing' && install) {
        setValues({});
        setInstallAccepted(true);
      } else onResolved(conf.confirmation_id);
    } catch (error: any) {
      showError(error);
      throw error;
    } finally {
      if (approved && authorize) checkingAuthorization.current = false;
    }
  };
  useEffect(() => {
    if (!authorize || !oauthUrl) return;
    return onMcpOAuthCompleted((id) => {
      if (id === conf.connection_id) void submit(true, false, '', true).catch(() => {});
    });
  }, [authorize, conf.connection_id, oauthUrl, submit]);
  const update = conf.operation === 'config_update';
  const read = conf.operation === 'config_read';
  const filter = read ? (conf.arguments as { looking_for?: string })?.looking_for : undefined;
  const reusable = resource || conf.operation === 'tool';
  const setup =
    conf.operation === 'install'
      ? (conf.arguments as {
          command?: string;
          url?: string;
          documentation?: string;
        })
      : undefined;
  const remoteInstall = !!setup?.url;
  const phase =
    conf.phase || (installAccepted ? (remoteInstall ? 'connecting' : 'installing') : undefined);
  const allowLabel = install
    ? remoteInstall
      ? 'mcp.design.connect'
      : 'mcp.installApproval.allow'
    : authorize
      ? 'mcp.authApproval.check'
      : update
        ? 'mcp.configApproval.apply'
        : 'chat.confirm.allow';

  return (
    <ConfirmationCard
      {...props}
      icon={
        props.icon ?? (
          <Icon
            size={16}
            name={
              authorize || localConfiguration
                ? 'key'
                : install
                  ? remoteInstall
                    ? 'globe'
                    : 'monitor'
                  : resource || read
                    ? 'file'
                    : 'terminal'
            }
          />
        )
      }
      actions={
        phase && install ? null : (
          <>
            <AllowButton
              submit={submit}
              label={t(allowLabel)}
              disabled={
                oauthBusy ||
                (localConfiguration &&
                  (!fields.length || fields.some((field) => !values[field.key]?.trim())))
              }
            />
            <RejectWithComment
              className={s.suggestMacroDismissBtn}
              onReject={(comment) => submit(false, false, comment)}
            />
          </>
        )
      }
      extraActions={
        !reusable ? undefined : (
          <>
            <p>{t(resource ? 'mcp.approvals.resourceHint' : 'mcp.approvals.toolHint')}</p>
            <AllowButton
              remember
              submit={submit}
              label={t(resource ? 'mcp.approvals.alwaysResource' : 'mcp.approvals.alwaysTool')}
            />
          </>
        )
      }
    >
      <div className={styles.content}>
        <div className={styles.server}>{conf.server_name}</div>
        {setup ? (
          <>
            <div className={styles.preview}>
              <span className={styles.caption}>
                <Icon name={remoteInstall ? 'globe' : 'terminal'} size={14} />
                {t(remoteInstall ? 'mcp.installApproval.address' : 'mcp.installApproval.command')}
              </span>
              <pre className={styles.code}>{setup.url || setup.command}</pre>
            </div>
            {!remoteInstall && <p className={styles.hint}>{t('mcp.installApproval.localHelp')}</p>}
            {setup.documentation && (
              <a
                className={styles.documentation}
                href={setup.documentation}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="book" size={14} />
                {t('mcp.installApproval.documentation')}
                <span aria-hidden="true">↗</span>
              </a>
            )}
          </>
        ) : authorize ? (
          <>
            <p className={styles.hint}>{t('mcp.authApproval.remoteHelp')}</p>
            {oauthUrl ? (
              <a className={styles.documentation} href={oauthUrl} target="_blank" rel="noreferrer">
                <Icon name="lock" size={14} />
                {t('mcp.openAuthorization')}
                <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <button
                type="button"
                className={s.suggestMacroDismissBtn}
                disabled={oauthBusy}
                onClick={() => void openOAuth()}
              >
                {t('mcp.authorize')}
              </button>
            )}
            <label className={styles.field}>
              {t('mcp.token')}
              <input
                className={settingsStyles.fieldInput}
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
          </>
        ) : localConfiguration ? (
          !phase && (
            <>
              <p className={styles.hint}>{t('mcp.authApproval.localHelp')}</p>
              {fields.map((field) => (
                <label className={styles.field} key={field.key}>
                  {field.label}
                  <input
                    className={settingsStyles.fieldInput}
                    type={field.secret ? 'password' : 'text'}
                    autoComplete={field.secret ? 'new-password' : 'off'}
                    value={values[field.key] ?? ''}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </>
          )
        ) : read ? (
          <div className={styles.readDetails}>
            <p>
              {filter ? (
                <>
                  {t('mcp.configApproval.filter')} <code>{filter}</code>
                </>
              ) : (
                t('mcp.configApproval.all')
              )}
            </p>
            <small className={styles.hint}>{t('mcp.configApproval.privacy')}</small>
          </div>
        ) : (
          <div className={styles.preview}>
            {reusable && <code className={styles.target}>{conf.target}</code>}
            <pre className={styles.code}>{JSON.stringify(conf.arguments, null, 2)}</pre>
          </div>
        )}
        {install && phase && (
          <p className={styles.progress} role="status">
            <span aria-hidden="true" className={activityStyles.spinner} />
            {t('mcp.local.' + phase)}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </ConfirmationCard>
  );
}
