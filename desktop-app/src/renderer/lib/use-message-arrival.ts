import { useLayoutEffect, useRef } from 'react';
import { animateMessageArrival } from './appearance-runtime';
export function useMessageArrival(
  messages: readonly { id: number }[],
  chatId: number | null,
  ready: boolean,
) {
  const previous = useRef<{ chatId: number | null; ids: number[] }>({ chatId: null, ids: [] });
  useLayoutEffect(() => {
    if (!ready) {
      previous.current = { chatId: null, ids: [] };
      return;
    }
    const old = previous.current,
      ids = messages.map((m) => m.id);
    if (old.chatId === chatId && old.ids.length && ids.length > old.ids.length) {
      const known = new Set(old.ids),
        last = ids.indexOf(old.ids[old.ids.length - 1]);
      for (const id of ids.slice(last >= 0 ? last + 1 : old.ids.length)) {
        if (known.has(id)) continue;
        const element = document.querySelector<HTMLElement>('[data-message-id="' + id + '"]');
        if (element) animateMessageArrival(element);
      }
    }
    previous.current = { chatId, ids };
  }, [messages, chatId, ready]);
}
