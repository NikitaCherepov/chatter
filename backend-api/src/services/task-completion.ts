export type TaskCompletion = { notify_user: boolean; message: string };

export const finishTaskTool = {
  type: 'function' as const,
  function: {
    name: 'finish_task',
    description: 'Finish this scheduled run. Call once, alone, after all other tools. notify_user=false means no message should be delivered. Intermediate text is never a notification.',
    parameters: {
      type: 'object',
      properties: {
        notify_user: { type: 'boolean', description: 'Whether this run has a result the user should receive, according to their instruction.' },
        message: { type: 'string', description: 'Final user-facing result. Required and non-empty when notify_user=true; empty when false.' },
      },
      required: ['notify_user', 'message'],
      additionalProperties: false,
    },
  },
};

export function parseTaskCompletion(raw: unknown): TaskCompletion {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.notify_user !== 'boolean' || typeof value.message !== 'string'
    || Object.keys(value).some(key => key !== 'notify_user' && key !== 'message')) throw new Error('invalid_task_completion');
  const message = value.message.trim();
  if (message.length > 100_000 || (value.notify_user ? !message : !!message)) throw new Error('invalid_task_completion_message');
  return { notify_user: value.notify_user, message };
}
