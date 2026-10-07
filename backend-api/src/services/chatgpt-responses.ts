import OpenAI from 'openai';
import { getChatGptAccessToken, assertChatGptAccess } from './chatgpt-connections.js';

export function buildChatGptRequest(payload: any) {
  const input: any[] = [];
  const content = (value: any) => {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(part => {
      if (part.type === 'text') return { type: 'input_text', text: part.text };
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
      throw new Error('chatgpt_unsupported_input');
    });
  };
  for (const message of payload.messages || []) {
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }); continue; }
    if (Array.isArray(message.responses_output)) { input.push(...message.responses_output); continue; }
    const role = message.role === 'system' ? 'developer' : message.role;
    if (message.content) input.push({ role, content: content(message.content) });
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', namespace: 'chatter', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  const functions = (payload.tools || []).map((tool: any) => {
    if (tool.type !== 'function') throw new Error('chatgpt_unsupported_tool');
    return { type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: false };
  });
  return { model: payload.model, input, store: false, stream: true, include: ['reasoning.encrypted_content'],
    ...(functions.length ? { tools: [{ type: 'namespace', name: 'chatter', description: 'Available Chatter tools', tools: functions }] } : {}),
    ...(payload.reasoning_effort ? { reasoning: { effort: payload.reasoning_effort } } : payload.reasoning?.effort ? { reasoning: { effort: payload.reasoning.effort } } : {}),
  };
}
export async function* parseChatGptEvents(response: Response) {
  if (!response.body) throw new Error('chatgpt_empty_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
      if (buffer.length > 8 * 1024 * 1024) throw new Error('chatgpt_invalid_stream');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function chatGptCompletion(connectionId: number, payload: any, signal?: AbortSignal, callbacks?: { onToken?: (text: string) => void; onReasoningToken?: (text: string) => void }) {
  assertChatGptAccess(connectionId);
  const token = await getChatGptAccessToken(connectionId);
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildChatGptRequest(payload)), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'chatgpt_reauthorization_required' : response.status === 429 ? 'chatgpt_plan_limit_reached' : 'chatgpt_inference_failed');
  let completed: any;
  let emitted = false;
  for await (const event of parseChatGptEvents(response)) {
    signal?.throwIfAborted();
    if (event.type === 'response.output_text.delta') { emitted = true; callbacks?.onToken?.(event.delta); }
    if (event.type === 'response.refusal.delta') { emitted = true; callbacks?.onToken?.(event.delta); }
    if (event.type === 'response.reasoning_summary_text.delta') callbacks?.onReasoningToken?.(event.delta);
    if (event.type === 'error' || event.type === 'response.failed') {
      const code = event.response?.error?.code || event.code;
      throw new Error(code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable' ? 'chatgpt_plan_limit_reached' : 'chatgpt_inference_failed');
    }
    if (event.type === 'response.incomplete') throw new Error('chatgpt_incomplete_response');
    if (event.type === 'response.completed') { completed = event.response; break; }
  }
  if (!completed || completed.status !== 'completed' || !Array.isArray(completed.output)) throw new Error('chatgpt_incomplete_response');
  const text = completed.output.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content || []).filter((part: any) => part.type === 'output_text' || part.type === 'refusal').map((part: any) => part.text || part.refusal || '').join('');
  if (!emitted && text) callbacks?.onToken?.(text);
  const toolCalls = completed.output.filter((item: any) => item.type === 'function_call').map((item: any) => ({
    id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments },
  }));
  return { id: completed.id, choices: [{ message: { role: 'assistant', content: text, tool_calls: toolCalls,
    responses_output: completed.output,
    reasoning_content: completed.output.filter((item: any) => item.type === 'reasoning').flatMap((item: any) => item.summary || []).map((item: any) => item.text || '').join(''),
  }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: completed.usage?.input_tokens || 0, completion_tokens: completed.usage?.output_tokens || 0,
      total_tokens: completed.usage?.total_tokens || 0, prompt_tokens_details: { cached_tokens: completed.usage?.input_tokens_details?.cached_tokens || 0 },
      completion_tokens_details: { reasoning_tokens: completed.usage?.output_tokens_details?.reasoning_tokens || 0 } },
  };
}
const clients = new WeakMap<OpenAI, number>();
// Keep provider transport outside the runner; never cache a rotating OAuth token in an SDK client.
export function createChatGptClient(connectionId: number): OpenAI {
  const client = new OpenAI({ apiKey: 'chatgpt-plan-transport', baseURL: 'https://api.openai.com/v1' });
  clients.set(client, connectionId);
  return client;
}
export const chatGptConnectionForClient = (client: OpenAI) => clients.get(client);
