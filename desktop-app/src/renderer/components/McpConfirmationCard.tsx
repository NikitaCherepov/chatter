import { useContext, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmationCard, ConfirmationCardContext } from './ConfirmationCard';
import { RejectWithComment } from './RejectWithComment';
import { apiFetch, getApiErrorMessage } from '../lib/api';
import s from '../pages/ChatPage.module.scss';
export type McpConfirmation = {
  confirmation_id: string;
  connection_id: number;
  server_name: string;
  operation: 'tool' | 'resource';
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
}: {
  remember?: boolean;
  submit: (approved: boolean, remember?: boolean, comment?: string) => Promise<void>;
  resource: boolean;
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
          : 'chat.confirm.allow',
      )}
    </button>
  );
}
export function McpConfirmationCard({ confirmation: conf, onResolved, ...props }: Props) {
  const { t } = useTranslation(),
    [error, setError] = useState('');
  const submit = async (approved: boolean, remember = false, comment = '') => {
    setError('');
    try {
      await apiFetch('/api/v1/pc-commands/approve', {
        method: 'POST',
        body: JSON.stringify({
          confirmation_id: conf.confirmation_id,
          approved,
          remember_mcp: remember,
          ...(comment ? { rejection_comment: comment } : {}),
        }),
      });
      onResolved(conf.confirmation_id);
    } catch (error: any) {
      setError(getApiErrorMessage(error, t('chat.toasts.commandApprovalFailed')));
      throw error;
    }
  };
  const resource = conf.operation === 'resource';
  return (
    <ConfirmationCard
      {...props}
      actions={
        <>
          <AllowButton submit={submit} resource={resource} />
          <RejectWithComment
            className={s.suggestMacroDismissBtn}
            onReject={(comment) => submit(false, false, comment)}
          />
        </>
      }
      extraActions={
        <>
          <p>{t(resource ? 'mcp.approvals.resourceHint' : 'mcp.approvals.toolHint')}</p>
          <AllowButton remember submit={submit} resource={resource} />
        </>
      }
    >
      <div className={s.suggestMacroName}>{conf.server_name}</div>
      <div className={s.suggestMacroCommands}>
        <code className={s.suggestMacroCmd}>{conf.target}</code>
        <pre className={s.suggestMacroCmd}>{JSON.stringify(conf.arguments, null, 2)}</pre>
      </div>
      {error && <p role="alert">{error}</p>}
    </ConfirmationCard>
  );
}
