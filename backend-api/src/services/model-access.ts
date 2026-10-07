import { AsyncLocalStorage } from 'node:async_hooks';
import { allModels, getModelSettings } from './model-settings.js';
import { getChatGptConnection } from './chatgpt-connections.js';

export type ModelActor = { userId?: number; isAdmin: boolean };
const actors = new AsyncLocalStorage<ModelActor>();
const clients = new WeakMap<object, { cardId: string; route: string }>();
export const registerModelAccessClient = (client: object, cardId: string, route: string) => clients.set(client, { cardId, route });
export const withModelActor = <T>(actor: ModelActor, action: () => T): T => actors.run(actor, action);
export const currentModelActor = () => actors.getStore();
export function canUseModel(uniqueId: string | null | undefined, actor = actors.getStore(), client?: object): boolean {
  if (!uniqueId) return true;
  const settings = getModelSettings();
  const ref = client && clients.get(client);
  const candidates = ref ? ref.route === 'manual' ? settings.manualModels : ref.route === 'pro' ? settings.proModels : ref.route === 'lite' ? settings.liteModels : ref.route === 'vision-pro' ? [settings.visionModel] : settings.visionLiteModels || [] : allModels(settings);
  const entries = candidates.filter(model => model.model && (ref ? model.id === ref.cardId : model.uniqueId === uniqueId));
  if (ref && !entries.length) return false;
  return entries.every(model => {
    const mode = model.accessMode || (model.adminOnly ? 'admins' : 'all');
    if (mode === 'admins' && !actor?.isAdmin) return false;
    if (mode === 'selected' && (!actor?.userId || !model.allowedUserIds?.includes(actor.userId))) return false;
    if (model.auth === 'chatgpt') {
      try { if (!getChatGptConnection(model.chatGptConnectionId!).shared && !actor?.isAdmin) return false; }
      catch { return false; }
    }
    return true;
  });
}
export function assertModelAccess(uniqueId: string | null | undefined, client?: object) {
  if (!canUseModel(uniqueId, undefined, client)) throw new Error('model_access_denied');
}
