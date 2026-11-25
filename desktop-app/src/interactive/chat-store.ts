import type { AppearanceShellState } from '../main/appearance-shell-types';
import { SettingsTask } from './settings-store';

let snapshot: AppearanceShellState | undefined;
let scope: string | undefined;
const stores = new Map<string, { dispose(): void }>();

export function chatScope(state = snapshot): string | undefined {
  return state ? (state.scopeId ?? state.settings?.scopeId ?? 'runtime') : undefined;
}
export const chatSnapshot = () => snapshot;
export function chatCurrent(owner: string | undefined, chatId?: number | null) {
  return (
    owner !== undefined &&
    owner === scope &&
    !!snapshot &&
    (chatId === undefined || (chatId !== null && snapshot.activeChatId === chatId))
  );
}
export function updateChatState(state: AppearanceShellState) {
  const next = chatScope(state);
  if (next !== scope) {
    for (const store of stores.values()) store.dispose();
    stores.clear();
    for (const task of previewTasks.values()) task.dispose();
    previewTasks.clear();
    previewScope = next;
    scope = next;
  }
  snapshot = state;
}
export function chatStore<T extends { dispose(): void }>(key: string, create: () => T): T {
  if (!stores.has(key)) stores.set(key, create());
  return stores.get(key) as T;
}

export type ComposerDraft = { text: string; transcriptId: number | null };
/** One draft per chat in the current runtime/account. No writes or sending on mount/unmount. */
export class ComposerStore {
  private state: ComposerDraft = { text: '', transcriptId: null };
  private listeners = new Set<() => void>();
  private sentSnapshot: AppearanceShellState | undefined;
  constructor(private current: () => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<ComposerDraft>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  setText = (text: string) => {
    if (!this.current() || typeof text !== 'string' || text.length > 100000) return false;
    this.publish({ text });
    return true;
  };
  appendTranscript(transcript: { id: number; text: string } | null | undefined) {
    if (!this.current() || !transcript || this.state.transcriptId === transcript.id) return;
    const text =
      this.state.text + (this.state.text && transcript.text ? ' ' : '') + transcript.text;
    // Never silently truncate a transcript or repeatedly insert one that exceeds the draft budget.
    if (text.length > 100000) return;
    this.publish({ text, transcriptId: transcript.id });
  }
  send(
    state: AppearanceShellState | undefined,
    send: (text: string) => boolean,
    text = this.state.text,
  ) {
    if (
      !this.current() ||
      !state?.canSend ||
      state.sending ||
      state.composer?.busy ||
      typeof text !== 'string' ||
      text.length > 100000 ||
      (!text.trim() && !state.attachmentCount) ||
      this.sentSnapshot === state
    )
      return false;
    // The bridge must run synchronously inside the user's event, before any await.
    if (!send(text)) return false;
    this.sentSnapshot = state;
    if (text === this.state.text) this.publish({ text: '' });
    return true;
  }
  dispose() {
    this.listeners.clear();
  }
}

/** Pending confirmation fields are shared too: another consumer cannot approve before their echo. */
export class ConfirmationFieldsStore {
  private state: Record<string, string | boolean> = {};
  private listeners = new Set<() => void>();
  constructor(private current: () => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: Record<string, string | boolean>) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  sync(card: AppearanceShellState['confirmations'][number] | undefined) {
    const next = { ...this.state };
    for (const id of Object.keys(next)) {
      const field = card?.fields.find((field) => field.id === id);
      if (!field || field.disabled || field.value === next[id]) delete next[id];
    }
    if (Object.keys(next).length !== Object.keys(this.state).length) this.publish(next);
  }
  set(id: string, value: string | boolean, write: () => boolean) {
    if (!this.current() || !write()) return false;
    this.publish({ ...this.state, [id]: value });
    return true;
  }
  clear = () => {
    if (this.current()) this.publish({});
  };
  dispose() {
    this.listeners.clear();
  }
}

export type TimelineItem =
  | { kind: 'message'; key: string; message: AppearanceShellState['messages'][number] }
  | {
      kind: 'summary';
      key: string;
      summary: NonNullable<NonNullable<AppearanceShellState['context']>['summary']>;
    };
export function conversationTimeline(
  state: Pick<AppearanceShellState, 'messages' | 'context'>,
): TimelineItem[] {
  const items: TimelineItem[] = [],
    summary = state.context?.summary;
  let inserted = false;
  const insert = () => {
    if (!summary || inserted) return;
    items.push({ kind: 'summary', key: 'summary:' + summary.throughTimelineIndex, summary });
    inserted = true;
  };
  for (const message of state.messages) {
    if (
      summary &&
      message.timelineIndex != null &&
      message.timelineIndex > summary.throughTimelineIndex
    )
      insert();
    items.push({
      kind: 'message',
      key: 'message:' + message.id + ':' + message.variantIndex,
      message,
    });
  }
  insert();
  return items;
}

/** Small shared cache for previews. Pending reads deduplicate; evicted/stale tasks cannot publish. */
class PreviewTask<T> extends SettingsTask<T> {
  consumers = 0;
  constructor(current: () => boolean) {
    super(current);
    const subscribe = this.subscribe;
    this.subscribe = (listener) => {
      this.consumers++;
      const release = subscribe(listener);
      return () => {
        this.consumers--;
        release();
      };
    };
  }
}
const previewTasks = new Map<string, PreviewTask<unknown>>();
let previewScope: string | undefined;
export function previewTask<T>(owner: string | undefined, key: string, current: () => boolean) {
  if (previewScope !== owner) {
    for (const task of previewTasks.values()) task.dispose();
    previewTasks.clear();
    previewScope = owner;
  }
  let task = previewTasks.get(key);
  if (!task) {
    task = new PreviewTask(current);
    previewTasks.set(key, task);
    // Keep live reads intact. The cache can temporarily grow while all entries are in use.
    for (const [oldKey, old] of previewTasks) {
      if (previewTasks.size <= 16) break;
      if (oldKey !== key && !old.consumers && !old.getSnapshot().busy) {
        old.dispose();
        previewTasks.delete(oldKey);
      }
    }
  }
  return task as SettingsTask<T>;
}
