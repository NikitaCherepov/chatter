import { useContext, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmationCard, ConfirmationCardContext } from './ConfirmationCard';
import { RejectWithComment } from './RejectWithComment';
import { apiFetch, getApiErrorMessage } from '../lib/api';
import s from '../pages/ChatPage.module.scss';
export type McpConfirmation = {
  confirmation_id: string;
  connection_id?: number;
  server_name: string;
  operation: 'tool' | 'resource' | 'install' | 'config_read' | 'config_update';
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
  update,
}: {
  remember?: boolean;
  submit: (approved: boolean, remember?: boolean, comment?: string) => Promise<void>;
  resource: boolean;
  install?: boolean;
  update?: boolean;
}) {
  const { t } = useTranslation(),
    card = useContext(ConfirmationCardContext);
  return (
    <button
      type="button"
      className={s.suggestMacroSaveBtn}
      disabled={card?.busy}
      onClick={() => void card?.run(() => submit(true, remember)).catch(() => {})}
    >
      {t(
        remember
          ? resource
            ? 'mcp.approvals.alwaysResource'
            : 'mcp.approvals.alwaysTool'
          : install
            ? 'mcp.installApproval.allow'
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
    [installAccepted, setInstallAccepted] = useState(false);
  const submit = async (approved: boolean, remember = false, comment = '') => {
    setError('');
    try {
      const result = await apiFetch<{ status?: string }>('/api/v1/pc-commands/approve', {
        method: 'POST',
        body: JSON.stringify({
          confirmation_id: conf.confirmation_id,
          approved,
          remember_mcp: remember,
          ...(comment ? { rejection_comment: comment } : {}),
        }),
      });
      if (result?.status === 'executing' && conf.operation === 'install') setInstallAccepted(true);
      else onResolved(conf.confirmation_id);
    } catch (error: any) {
      setError(getApiErrorMessage(error, t('chat.toasts.commandApprovalFailed')));
      throw error;
    }
  };
  const resource = conf.operation === 'resource';
  const install = conf.operation === 'install';
  const update = conf.operation === 'config_update';
  const read = conf.operation === 'config_read';
  const filter = read ? (conf.arguments as { looking_for?: string })?.looking_for : undefined;
  const reusable = resource || conf.operation === 'tool';
  const phase = conf.phase || (installAccepted ? 'installing' : undefined);
  const setup = install
    ? (conf.arguments as { command?: string; url?: string; documentation?: string })
    : undefined;
  return (
    <ConfirmationCard
      {...props}
      actions={
        phase && install ? null : (
          <>
            <AllowButton submit={submit} resource={resource} install={install} update={update} />
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
