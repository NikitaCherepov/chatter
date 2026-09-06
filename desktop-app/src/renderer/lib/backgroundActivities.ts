export type BackgroundActivityStatus = 'working' | 'idle' | 'challenge';

export type BackgroundActivityOpenTarget =
  | { type: 'browser_session'; sessionId: string }
  | { type: 'app_tool'; toolId: string; title?: string };

export type BackgroundActivityInput = {
  id: string;
  chatId: number | null;
  title: string;
  status: BackgroundActivityStatus;
  openTarget: BackgroundActivityOpenTarget;
  image?: string;
  updatedAt?: number;
};

export function upsertBackgroundActivity(activity: BackgroundActivityInput) {
  return window.electronAPI.upsertBackgroundActivity(activity);
}

export function removeBackgroundActivity(id: string) {
  return window.electronAPI.removeBackgroundActivity(id);
}
