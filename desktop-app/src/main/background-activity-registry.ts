export type BackgroundActivityStatus = 'working' | 'idle' | 'challenge';

export type BackgroundActivityOpenTarget =
  | { type: 'browser_session'; sessionId: string }
  | { type: 'app_tool'; toolId: string; title?: string };

export type BackgroundActivity = {
  id: string;
  chatId: number | null;
  title: string;
  status: BackgroundActivityStatus;
  openTarget: BackgroundActivityOpenTarget;
  image?: string;
  updatedAt: number;
};

export type BackgroundActivitySnapshot = {
  activeChatId: number | null;
  activities: BackgroundActivity[];
};

export type ActiveBackgroundActivityPreview = {
  active: boolean;
  activityId?: string;
  chatId: number | null;
  image?: string;
};

type BackgroundActivityRegistryOptions = {
  emitState: (snapshot: BackgroundActivitySnapshot) => void;
  emitActivePreview: (payload: ActiveBackgroundActivityPreview) => void;
};

const normalizeChatId = (chatId: unknown): number | null => (
  Number.isInteger(chatId) && Number(chatId) > 0 ? Number(chatId) : null
);

export class BackgroundActivityRegistry {
  private readonly activities = new Map<string, BackgroundActivity>();
  private activeChatId: number | null = null;

  constructor(private readonly options: BackgroundActivityRegistryOptions) {}

  setActiveChatId(chatId: unknown): BackgroundActivitySnapshot {
    this.activeChatId = normalizeChatId(chatId);
    return this.emit();
  }

  get(id: string): BackgroundActivity | undefined {
    return this.activities.get(id);
  }

  upsert(activity: Omit<BackgroundActivity, 'updatedAt'> & { updatedAt?: number }): BackgroundActivitySnapshot {
    const id = `${activity.id || ''}`.trim();
    if (!id) throw new Error('background_activity_id_required');
    const previous = this.activities.get(id);
    this.activities.set(id, {
      ...previous,
      ...activity,
      id,
      chatId: normalizeChatId(activity.chatId),
      updatedAt: activity.updatedAt ?? Date.now(),
    });
    return this.emit();
  }

  setStatus(
    id: string,
    status: BackgroundActivityStatus,
    details: Partial<Pick<BackgroundActivity, 'chatId' | 'title' | 'image' | 'openTarget'>> = {},
  ): BackgroundActivitySnapshot {
    const previous = this.activities.get(id);
    if (!previous) throw new Error(`background_activity_not_found:${id}`);
    return this.upsert({ ...previous, ...details, status });
  }

  remove(id: string): BackgroundActivitySnapshot {
    this.activities.delete(id);
    return this.emit();
  }

  clear(): BackgroundActivitySnapshot {
    this.activities.clear();
    return this.emit();
  }

  snapshot(): BackgroundActivitySnapshot {
    return {
      activeChatId: this.activeChatId,
      activities: [...this.activities.values()]
        .filter((activity) => activity.chatId === null || activity.chatId === this.activeChatId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    };
  }

  private emit(): BackgroundActivitySnapshot {
    const snapshot = this.snapshot();
    this.options.emitState(snapshot);
    const active = snapshot.activities.find((activity) => activity.status === 'working');
    this.options.emitActivePreview(active
      ? { active: true, activityId: active.id, chatId: active.chatId, image: active.image }
      : { active: false, chatId: this.activeChatId });
    return snapshot;
  }
}
