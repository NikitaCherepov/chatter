import type { BrowserPreviewPayload, BrowserPreviewSource } from './browser-preview';

export type BrowserSessionStatus = 'working' | 'idle' | 'challenge';

export type BrowserSessionSnapshot = {
  id: string;
  chatId: number | null;
  source: BrowserPreviewSource;
  status: BrowserSessionStatus;
  image?: string;
  title?: string;
  updatedAt: number;
};

export type BrowserSessionRegistrySnapshot = {
  activeChatId: number | null;
  sessions: BrowserSessionSnapshot[];
};

type BrowserSessionRegistryOptions = {
  emitState: (snapshot: BrowserSessionRegistrySnapshot) => void;
  emitActivePreview: (payload: BrowserPreviewPayload) => void;
};

const normalizeChatId = (chatId: unknown): number | null => (
  Number.isInteger(chatId) && Number(chatId) > 0 ? Number(chatId) : null
);

export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserSessionSnapshot>();
  private activeChatId: number | null = null;

  constructor(private readonly options: BrowserSessionRegistryOptions) {}

  static sessionId(source: BrowserPreviewSource, chatId: unknown): string {
    return `${source}:${normalizeChatId(chatId) ?? 'unscoped'}`;
  }

  setActiveChatId(chatId: unknown): BrowserSessionRegistrySnapshot {
    this.activeChatId = normalizeChatId(chatId);
    return this.emit();
  }

  updatePreview(payload: BrowserPreviewPayload): BrowserSessionRegistrySnapshot {
    // Preview producers always identify their source. The source is optional only
    // for the synthesized "nothing active in this chat" renderer event.
    if (!payload.source) return this.emit();
    const chatId = normalizeChatId(payload.chatId);
    const id = BrowserSessionRegistry.sessionId(payload.source, chatId);
    const previous = this.sessions.get(id);
    this.sessions.set(id, {
      id,
      chatId,
      source: payload.source,
      status: payload.active ? 'working' : (previous?.status === 'challenge' ? 'challenge' : 'idle'),
      image: payload.image ?? previous?.image,
      title: previous?.title,
      updatedAt: Date.now(),
    });
    return this.emit();
  }

  setStatus(
    source: BrowserPreviewSource,
    chatIdValue: unknown,
    status: BrowserSessionStatus,
    details: { image?: string; title?: string } = {},
  ): BrowserSessionRegistrySnapshot {
    const chatId = normalizeChatId(chatIdValue);
    const id = BrowserSessionRegistry.sessionId(source, chatId);
    const previous = this.sessions.get(id);
    this.sessions.set(id, {
      id,
      chatId,
      source,
      status,
      image: details.image ?? previous?.image,
      title: details.title ?? previous?.title,
      updatedAt: Date.now(),
    });
    return this.emit();
  }

  remove(source: BrowserPreviewSource, chatId: unknown): BrowserSessionRegistrySnapshot {
    this.sessions.delete(BrowserSessionRegistry.sessionId(source, chatId));
    return this.emit();
  }

  clear(): BrowserSessionRegistrySnapshot {
    this.sessions.clear();
    return this.emit();
  }

  snapshot(): BrowserSessionRegistrySnapshot {
    return {
      activeChatId: this.activeChatId,
      sessions: [...this.sessions.values()]
        .filter((session) => session.chatId === this.activeChatId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    };
  }

  private emit(): BrowserSessionRegistrySnapshot {
    const snapshot = this.snapshot();
    this.options.emitState(snapshot);
    const active = snapshot.sessions.find((session) => session.status === 'working');
    this.options.emitActivePreview(active
      ? { active: true, source: active.source, chatId: active.chatId, image: active.image }
      : { active: false, chatId: this.activeChatId });
    return snapshot;
  }
}
