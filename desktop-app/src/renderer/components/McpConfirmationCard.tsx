import { useContext, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmationCard, ConfirmationCardContext } from './ConfirmationCard';
import { RejectWithComment } from './RejectWithComment';
import { apiFetch, getApiErrorMessage, onMcpOAuthCompleted } from '../lib/api';
import { authorizeMcp, refreshMcpTools, saveMcpConnection } from '../lib/mcp-service';
import { packageFields, packageFromSource } from '../../main/local-mcp-spec';
import s from '../pages/ChatPage.module.scss';
import settingsStyles from './SettingsModal.module.scss';
export type McpConfirmation = {
  confirmation_id: string;
  connection_id?: number;
  server_name: string;
  operation: 'tool' | 'resource' | 'install' | 'install_config' | 'authorize' | 'config_read' | 'config_update';
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
  remember,
  submit,
  resource,
  install,
  duplicate,
  update,
  authorize,
  disabled,
}: {
  remember?: boolean;
  submit: (approved: boolean, remember?: boolean, comment?: string) => Promise<void>;
  resource: boolean;
  install?: boolean;
  duplicate?: boolean;
  update?: boolean;
  authorize?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation(),
    card = useContext(ConfirmationCardContext);
  return (
    <button
      type="button"
      className={s.suggestMacroSaveBtn}
      disabled={card?.busy || disabled}
      onClick={() => void card?.run(() => submit(true, remember)).catch(() => {})}
    >
      {t(
        remember
          ? resource
            ? 'mcp.approvals.alwaysResource'
            : 'mcp.approvals.alwaysTool'
          : install
            ? duplicate ? 'mcp.catalogConnection.addAnother' : 'mcp.installApproval.allow'
            : authorize
              ? 'mcp.authApproval.check'
              : update
              ? 'mcp.configApproval.apply'
              : 'chat.confirm.allow',
      )}
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
  const fields = pkg ? packageFields(pkg).filter(
    (field) => field.required && !String(configured?.[field.key] ?? field.default).trim(),
  ) : [];
  const showError = (error: any) => {
    const code = error?.body?.error || error?.message;
    setError(getApiErrorMessage(error, t('mcp.errors.' + code, { defaultValue: t('chat.toasts.commandApprovalFailed') })));
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
  const submit = async (approved: boolean, remember = false, comment = '', oauthVerified = false) => {
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
      }
      else onResolved(conf.confirmation_id);
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
  const phase = conf.phase || (installAccepted ? 'installing' : undefined);
  const setup = conf.operation === 'install'
    ? (conf.arguments as { command?: string; url?: string; documentation?: string; allow_duplicate?: boolean })
    : undefined;
  return (
    <ConfirmationCard
      {...props}
      actions={
        phase && install ? null : (
          <>
            <AllowButton
              submit={submit}
              resource={resource}
              install={install}
              duplicate={setup?.allow_duplicate}
              update={update}
              authorize={authorize}
              disabled={oauthBusy || (localConfiguration && (!fields.length || fields.some((field) => !values[field.key]?.trim())))}
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
            <AllowButton remember submit={submit} resource={resource} />
          </>
        )
      }
    >
      <div className={s.suggestMacroName}>{conf.server_name}</div>
      <div className={s.suggestMacroCommands}>
        {setup ? (
          <>
            <pre className={s.suggestMacroCmd}>{setup.command || setup.url}</pre>
            {setup.documentation && (
              <a href={setup.documentation} target="_blank" rel="noreferrer">
                {t('mcp.github.instructions')}
              </a>
            )}
          </>
        ) : authorize ? (
          <>
            <p>{t('mcp.authApproval.remoteHelp')}</p>
            {oauthUrl ? (
              <a href={oauthUrl} target="_blank" rel="noreferrer">{t('mcp.openAuthorization')}</a>
            ) : (
              <button type="button" className={s.suggestMacroDismissBtn} disabled={oauthBusy}
                onClick={() => void openOAuth()}>
                {t('mcp.authorize')}
              </button>
            )}
            <label>
              {t('mcp.token')}
              <input className={settingsStyles.fieldInput} type="password" autoComplete="new-password"
                value={token} onChange={(event) => setToken(event.target.value)} />
            </label>
          </>
        ) : localConfiguration ? (
          !phase && (
            <>
              <p>{t('mcp.authApproval.localHelp')}</p>
              {fields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input className={settingsStyles.fieldInput} type={field.secret ? 'password' : 'text'}
                    autoComplete="off" value={values[field.key] ?? ''}
                    onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))} />
                </label>
              ))}
            </>
          )
        ) : read ? (
          <div>
            <p>
              {filter ? (
                <>
                  {t('mcp.configApproval.filter')} <code>{filter}</code>
                </>
              ) : (
                t('mcp.configApproval.all')
              )}
            </p>
            <small>{t('mcp.configApproval.privacy')}</small>
          </div>
        ) : (
          <>
            {reusable && <code className={s.suggestMacroCmd}>{conf.target}</code>}
            <pre className={s.suggestMacroCmd}>{JSON.stringify(conf.arguments, null, 2)}</pre>
          </>
        )}
      </div>
      {install && phase && <p role="status">{t('mcp.local.' + phase)}</p>}
      {error && <p role="alert">{error}</p>}
    </ConfirmationCard>
  );
}
