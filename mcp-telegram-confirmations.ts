import axios from 'axios';
import { Markup } from 'telegraf';
type Options = {
  base: string;
  token: string;
  requestRejectionComment: (ctx: any, endpoint: string, id: string, label: string) => Promise<void>;
};
export function registerMcpTelegramConfirmations(bot: any, options: Options) {
  const messages = new Map<
    string,
    {
      userId: number;
      chatId: number;
      messageId: number;
      text: string;
      document: boolean;
      label: string;
    }
  >();
  const processing = new Set<string>();
  const finish = async (ctx: any, id: string, status: string) => {
    const entry = messages.get(id);
    if (!entry) return;
    messages.delete(id);
    processing.delete(id);
    const translated = ctx.t(
      'mcpConfirmation.' +
        (status === 'executed'
          ? 'executed'
          : status === 'rejected'
            ? 'rejected'
            : status === 'expired'
              ? 'expired'
              : 'failed'),
    );
    const text = entry.text + '\n\n' + translated;
    if (entry.document)
      await ctx.telegram
        .editMessageCaption(entry.chatId, entry.messageId, undefined, text, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
    else
      await ctx.telegram
        .editMessageText(entry.chatId, entry.messageId, undefined, text, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
  };
  bot.action(/^mcpconfirm:(allow|always|reject|reject_comment):(.+)$/, async (ctx: any) => {
    const decision = ctx.match[1],
      id = ctx.match[2],
      userId = ctx.state.accountId;
    if (!userId || (messages.has(id) && messages.get(id)!.userId !== userId)) {
      await ctx.answerCbQuery(ctx.t('confirmations.userUnknown'));
      return;
    }
    if (!messages.has(id)) {
      await ctx.answerCbQuery(ctx.t('mcpConfirmation.expired'));
      return;
    }
    if (processing.has(id)) {
      await ctx.answerCbQuery(ctx.t('confirmations.executing'));
      return;
    }
    if (decision === 'reject_comment') {
      await options.requestRejectionComment(
        ctx,
        '/internal/pc-commands/approve',
        id,
        messages.get(id)?.label || 'MCP',
      );
      return;
    }
    processing.add(id);
    await ctx.answerCbQuery(
      ctx.t(decision === 'reject' ? 'confirmations.rejected' : 'confirmations.executing'),
    );
    void (async () => {
      try {
        const response = await axios.post(
          options.base + '/internal/pc-commands/approve',
          {
            user_id: userId,
            confirmation_id: id,
            approved: decision !== 'reject',
            remember_mcp: decision === 'always',
          },
          { headers: { Authorization: 'Bearer ' + options.token }, timeout: 0 },
        );
        await finish(ctx, id, response.data?.status || 'executed');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      } catch (error: any) {
        await finish(ctx, id, error?.response?.status === 404 ? 'expired' : 'failed');
      }
    })();
  });
  return async (ctx: any, action: any): Promise<boolean> => {
    const value = action?.value;
    if (action?.action === 'confirmation_resolved' && messages.has(value?.confirmation_id)) {
      await finish(ctx, value.confirmation_id, value.status);
      return true;
    }
    if (action?.action !== 'mcp_confirmation' || !value?.confirmation_id) return false;
    const id = value.confirmation_id;
    if (messages.has(id)) return true;
    const reusable = value.operation === 'tool' || value.operation === 'resource';
    const label = String(value.server_name || 'MCP') + ' / ' + String(value.target || '');
    const args = JSON.stringify(value.arguments, null, 2),
      header = ctx.t('mcpConfirmation.title') + '\n' + label.slice(0, 700);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(ctx.t('confirmations.buttons.allow'), 'mcpconfirm:allow:' + id),
        Markup.button.callback(ctx.t('confirmations.buttons.reject'), 'mcpconfirm:reject:' + id),
      ],
      ...(!reusable ? [] : [[
        Markup.button.callback(
          ctx.t(
            value.operation === 'resource'
              ? 'mcpConfirmation.alwaysResource'
              : 'mcpConfirmation.alwaysTool',
          ),
          'mcpconfirm:always:' + id,
        ),
      ]]),
      [
        Markup.button.callback(
          ctx.t('confirmations.buttons.rejectWithComment'),
          'mcpconfirm:reject_comment:' + id,
        ),
      ],
    ]);
    const hint = !reusable ? '' : ctx.t(
      value.operation === 'resource' ? 'mcpConfirmation.resourceHint' : 'mcpConfirmation.toolHint',
    );
    const text = header + '\n\n' + args + '\n\n' + hint;
    const document = text.length > 3500;
    const caption = header + '\n\n' + hint;
    const sent = document
      ? await ctx.replyWithDocument(
          { source: Buffer.from(args), filename: 'mcp-arguments.json' },
          { caption, ...keyboard },
        )
      : await ctx.reply(text, keyboard);
    messages.set(id, {
      userId: ctx.state.accountId,
      chatId: sent.chat.id,
      messageId: sent.message_id,
      text: document ? caption : text,
      document,
      label,
    });
    return true;
  };
}
