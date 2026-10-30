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
      tool_status: null,
      intermediate_messages: [],
      work_log: [],
      created_at: Math.floor(Date.now() / 1000),
    };
  }
  event(payload: Record<string, unknown>): Record<string, unknown> {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (payload.type === 'chat_tool_status') {
      this.data.tool_status = text;
      const steps = this.data.work_log as any[];
      const call = payload.call as {id?:string;name?:string;running?:boolean} | undefined;
      if (call?.id && call.name) {
        const index = steps.findIndex(step => step.type === 'tool' && step.call.id === call.id);
        this.data.work_log = index < 0 ? [...steps,{type:'tool',call}]
          : steps.map((step,i) => i === index ? {type:'tool',call} : step);
      } else if (text.trim() && !steps.some(step => step.type === 'tool' && step.call.running)) {
        this.data.work_log = [...steps, {type:'activity',text}];
      }
    }
    else if (['chat_agent_token', 'chat_agent_reasoning', 'chat_intermediate'].includes(String(payload.type))) {
      this.data.tool_status = null;
      if (payload.type === 'chat_agent_token') this.data.content = String(this.data.content) + text;
      else if (payload.type === 'chat_agent_reasoning') this.data.reasoning_content = String(this.data.reasoning_content) + text;
      else {
        this.data.content = typeof payload.content === 'string' ? payload.content
          : this.data.content ? `${this.data.content}\n\n${text}` : text;
        if (text.trim()) {
          this.data.intermediate_messages = [...this.data.intermediate_messages as string[], text.trim()];
          this.data.work_log = [...this.data.work_log as unknown[], {type:'message',text:text.trim()}];
        }
      }
    } else return { ...payload, stream_id: this.data.stream_id };
    this.data.sequence = Number(this.data.sequence) + 1;
    return { ...payload, stream_id: this.data.stream_id, sequence: this.data.sequence };
  }
  snapshot() {
    return { ...this.data };
  }
}
