import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axios = require('axios').default;
const { registerMcpTelegramConfirmations } = require('../../mcp-telegram-confirmations.ts');
let handler: any;
const sends: any[] = [],
  requests: any[] = [],
  edits: any[] = [],
  comments: any[] = [];
const bot = {
  action: (_pattern: any, fn: any) => {
    handler = fn;
  },
};
const original = axios.post;
let release: any;
axios.post = async (url: any, body: any) => {
  requests.push({ url, body });
  await new Promise((r) => (release = r));
  return { data: { status: body.approved ? 'executed' : 'rejected' } };
};
const ctx: any = {
  state: { accountId: 81 },
  t: (key: string) => key,
  answerCbQuery: async () => {},
  reply: async (text: any, keyboard: any) => {
    sends.push({ text, keyboard });
    return { chat: { id: 81 }, message_id: sends.length };
  },
  replyWithDocument: async (doc: any, options: any) => {
    sends.push({ doc, options });
    return { chat: { id: 81 }, message_id: sends.length };
  },
  telegram: {
    editMessageText: async (...args: any[]) => edits.push(args),
    editMessageCaption: async (...args: any[]) => edits.push(args),
  },
  editMessageReplyMarkup: async () => {},
};
const onAction = registerMcpTelegramConfirmations(bot, {
  base: 'https://backend.example',
  token: 'internal',
  requestRejectionComment: async (...args: any[]) => comments.push(args),
});
const action = (id: string, text = 'hello') => ({
  action: 'mcp_confirmation',
  value: {
    confirmation_id: id,
    connection_id: 1,
    server_name: 'Fixture',
    target: 'echo',
    operation: 'tool',
    arguments: { text },
  },
});
try {
  assert.equal(await onAction(ctx, action('one')), true);
  assert.match(sends[0].text, /hello/);
  assert.equal(
    sends[0].keyboard.reply_markup.inline_keyboard[1][0].callback_data,
    'mcpconfirm:always:one',
  );
  await handler({ ...ctx, match: [null, 'always', 'one'], state: { accountId: 82 } });
  assert.equal(requests.length, 0, 'wrong account denied before HTTP');
  await handler({ ...ctx, match: [null, 'always', 'one'] });
  await handler({ ...ctx, match: [null, 'allow', 'one'] });
  assert.equal(requests.length, 1, 'double taps do not submit twice');
  assert.equal(requests[0].body.remember_mcp, true);
  assert.equal(requests[0].body.user_id, 81);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.match(edits[0][3], /executed/);
  await onAction(ctx, action('two'));
  await handler({ ...ctx, match: [null, 'reject_comment', 'two'] });
  assert.equal(comments[0][1], '/internal/pc-commands/approve');
  await onAction(ctx, {
    action: 'confirmation_resolved',
    value: { confirmation_id: 'two', status: 'rejected' },
  });
  assert.match(edits.at(-1)[3], /rejected/);
  await onAction(ctx, action('large', 'x'.repeat(5000)));
  assert.equal(
    JSON.parse(sends.at(-1).doc.source.toString()).text.length,
    5000,
    'long arguments stay complete',
  );
  await onAction(ctx, {
    action: 'confirmation_resolved',
    value: { confirmation_id: 'large', status: 'expired' },
  });
  assert.match(edits.at(-1)[3], /expired/);
  assert.equal(await onAction(ctx, { action: 'unrelated' }), false);
  console.log(
    'PASS: Telegram MCP confirmation buttons, owner, duplicate taps, remember, composer comment, full JSON arguments and resolved state',
  );
} finally {
  axios.post = original;
}
