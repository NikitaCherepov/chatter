import { useCallback, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AppearanceConfirmation } from '../../main/appearance-shell-types';
import type { ConfirmationProjection } from './confirmation-projection';

type Commands = Pick<ConfirmationProjection, 'commands' | 'changes'> & {
  run: (action: () => void | Promise<void>) => Promise<void>;
  busy: () => boolean;
};
type Model = Omit<AppearanceConfirmation, 'revision' | 'ready'>;
export type ConfirmationBridgeApi = {
  register: (model: Model, commands: Commands) => void;
  remove: (id: string) => void;
  execute: (id: string, action: string, revision: number, comment?: string) => Promise<void>;
  change: (id: string, field: string, value: string | boolean) => void;
};
export function useConfirmationBridge() {
  const entries = useRef(new Map<string, { model: AppearanceConfirmation; signature: string; commands: Commands }>());
  const sequence = useRef(0);
  const [cards, setCards] = useState<AppearanceConfirmation[]>([]);
  const publish = useCallback(() => setCards([...entries.current.values()].map(item => item.model)), []);
  const api = useMemo<ConfirmationBridgeApi>(() => ({
    register(model, commands) {
      const previous = entries.current.get(model.id), signature = JSON.stringify(model);
      const same = previous?.signature === signature;
      entries.current.set(model.id, { signature, commands, model: same ? previous.model : { ...model, ready: true, revision: ++sequence.current } });
      if (!same) publish();
    },
    remove(id) { if (entries.current.delete(id)) publish(); },
    async execute(id, actionId, revision, comment) {
      const current = entries.current.get(id), action = current?.model.actions.find(item => item.id === actionId);
      if (!current || current.model.revision !== revision) throw new Error('confirmation_changed');
      if (current.commands.busy() || !action || action.disabled || !current.model.customizable) throw new Error('confirmation_unavailable');
      if (action.comment && !comment?.trim()) throw new Error('confirmation_comment_required');
      const callback = current.commands.commands.get(actionId);
      if (!callback) throw new Error('confirmation_unavailable');
      await current.commands.run(() => callback(comment));
    },
    change(id, fieldId, value) {
      const current = entries.current.get(id), field = current?.model.fields.find(item => item.id === fieldId);
      if (!current || !field || field.disabled || current.commands.busy()) throw new Error('confirmation_unavailable');
      const callback = current.commands.changes.get(fieldId);
      if (!callback) throw new Error('confirmation_unavailable');
      // Publish the new native state before a subsequent approval can consume it.
      flushSync(() => callback(value));
    },
  }), [publish]);
  return { cards, api };
}
