import { randomUUID } from 'node:crypto';

/** Ephemeral display text only. Removed when this response completes. */
export class ChatStreamBuffer {
  private data: Record<string, unknown>;
  constructor(start: Record<string, unknown>) {
    this.data = {
      ...start,
      stream_id: randomUUID(),
      sequence: 0,
      content: '',
      reasoning_content: '',
      created_at: Math.floor(Date.now() / 1000),
    };
  }
  event(payload: Record<string, unknown>): Record<string, unknown> {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (payload.type === 'chat_agent_token') this.data.content = String(this.data.content) + text;
    else if (payload.type === 'chat_agent_reasoning')
      this.data.reasoning_content = String(this.data.reasoning_content) + text;
    else if (payload.type === 'chat_intermediate' || payload.type === 'chat_tool_status') {
      const formatted = payload.type === 'chat_tool_status' ? `_${text}_` : text;
      this.data.content = this.data.content ? `${this.data.content}\n\n${formatted}` : formatted;
    } else return { ...payload, stream_id: this.data.stream_id };
    this.data.sequence = Number(this.data.sequence) + 1;
    return { ...payload, stream_id: this.data.stream_id, sequence: this.data.sequence };
  }
  snapshot() {
    return { ...this.data };
  }
}
