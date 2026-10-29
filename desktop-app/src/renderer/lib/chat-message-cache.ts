import type { QueryClient } from '@tanstack/react-query';
import type { Message } from './api';

type Snapshot = { messages: Message[]; hasMore: boolean };
type Selection = { chatId: number; previous: Message; next: Message };

/** RAM-only, scoped to the backend and signed-in account. Stream buffers stay separate. */
export class ChatMessageCache {
  private pending = new Map<number, Selection>();
  private revisions = new Map<number, number>();
  constructor(private client: QueryClient, private scope: readonly unknown[]) {}
  private key(chatId: number) { return ['chat-messages', ...this.scope, chatId] as const; }
  private variantsKey(chatId: number, messageId: number) { return ['chat-message-variants', ...this.scope, chatId, messageId] as const; }
  read(chatId: number) { return this.client.getQueryData<Snapshot>(this.key(chatId)); }
  revision(chatId: number) { return this.revisions.get(chatId) ?? 0; }
  changed(chatId: number) { this.revisions.set(chatId, this.revision(chatId) + 1); }
  remember(chatId: number, messages: Message[], hasMore = this.read(chatId)?.hasMore ?? false) {
    this.client.setQueryDefaults(this.key(chatId), { gcTime: 10 * 60_000 });
    this.client.setQueryData(this.key(chatId), { messages: messages.filter(message => message.id > 0), hasMore });
    for (const message of messages) if (message.id > 0 && message.role === 'assistant') this.rememberVariant(chatId, message);
  }
  private rememberVariant(chatId: number, message: Message) {
    const key = this.variantsKey(chatId, message.id);
    this.client.setQueryDefaults(key, { gcTime: 10 * 60_000 });
    this.client.setQueryData<Message[]>(key, previous => [
      ...(previous ?? []).filter(item => item.variant_index !== message.variant_index), message,
    ]);
  }
  receiveVariants(chatId: number, variants: Message[]) {
    for (const message of variants) this.rememberVariant(chatId, message);
  }
  project(chatId: number, messages: Message[]) {
    const selection = this.pending.get(chatId);
    return selection ? messages.map(message => message.id === selection.next.id ? selection.next : message) : messages;
  }
  begin(chatId: number, previous: Message, index: number): Selection | null {
    if (this.pending.has(chatId)) return null;
    const variant = this.client.getQueryData<Message[]>(this.variantsKey(chatId, previous.id))?.find(message => message.variant_index === index);
    if (!variant) return null;
    const selection = { chatId, previous, next: { ...variant, variant_count: previous.variant_count, audio: null } };
    this.pending.set(chatId, selection);
    this.changed(chatId);
    this.replace(chatId, selection.next);
    return selection;
  }
  finish(selection: Selection, success: boolean, serverMessage?: Message): Message | undefined {
    if (this.pending.get(selection.chatId) !== selection) return;
    this.pending.delete(selection.chatId);
    this.changed(selection.chatId);
    const message = success ? serverMessage ?? selection.next : selection.previous;
    this.replace(selection.chatId, message);
    return message;
  }
  accept(chatId: number, message: Message) {
    this.pending.delete(chatId);
    this.changed(chatId);
    this.replace(chatId, message);
  }
  private replace(chatId: number, message: Message) {
    this.rememberVariant(chatId, message);
    const snapshot = this.read(chatId);
    if (snapshot) this.remember(chatId, snapshot.messages.some(item => item.id === message.id)
      ? snapshot.messages.map(item => item.id === message.id ? message : item)
      : [...snapshot.messages, message], snapshot.hasMore);
  }
}
