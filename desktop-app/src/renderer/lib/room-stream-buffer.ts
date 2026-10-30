export type RoomStreamSnapshot = {
  stream_id: string; sequence: number; content: string; reasoning_content: string; tool_status?: string | null;
  agent_id: number | null; prompt_id?: number | null; prompt_name?: string | null;
  prompt_image_url?: string | null; created_at: number; regenerate_message_id?: number | null;
};
type Delta = { stream_id?: string; sequence?: number; type: string; text?: string; content?: string };

/** Events newer than an HTTP snapshot are replayed once, in server order. */
export class RoomStreamBuffer {
  private value: RoomStreamSnapshot | null = null;
  private pending = new Map<number, Delta>();
  constructor(readonly streamId: string) {}
  read() { return this.value; }
  restore(snapshot: RoomStreamSnapshot) {
    if (snapshot.stream_id !== this.streamId || (this.value && this.value.sequence > snapshot.sequence)) return;
    this.value = { ...snapshot };
    for (const sequence of this.pending.keys()) if (sequence <= snapshot.sequence) this.pending.delete(sequence);
    this.drain();
  }
  push(event: Delta) {
    if (event.stream_id !== this.streamId || !Number.isSafeInteger(event.sequence) || event.sequence! <= (this.value?.sequence ?? 0)) return;
    this.pending.set(event.sequence!, event);
    this.drain();
  }
  private drain() {
    while (this.value && this.pending.has(this.value.sequence + 1)) {
      const sequence = this.value.sequence + 1, event = this.pending.get(sequence)!;
      this.pending.delete(sequence);
      const next = { ...this.value, sequence }, text = event.text ?? '';
      if (event.type === 'chat_tool_status') next.tool_status = text;
      else {
        next.tool_status = null;
        if (event.type === 'chat_agent_token') next.content += text;
        else if (event.type === 'chat_agent_reasoning') next.reasoning_content += text;
        else next.content = typeof event.content === 'string' ? event.content
          : next.content ? `${next.content}\n\n${text}` : text;
      }
      this.value = next;
    }
  }
}
