import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationComment, ConfirmationComposer } from '../components/ConfirmationCard';

export function useConfirmationComposer(chatId: number | null): ConfirmationComposer {
  const [comment, setComment] = useState<ConfirmationComment | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const rejectHandlers = useRef(new Map<string, ConfirmationComment['reject']>());
  useEffect(() => { setComment(null); }, [chatId]);
  const cancel = useCallback(() => { if (!submitting.current) setComment(null); }, []);
  const request = useCallback((target: Omit<ConfirmationComment, 'text'>) => {
    if (submitting.current) return;
    setComment(current => ({ ...target, reject: text => (rejectHandlers.current.get(target.id) || target.reject)(text), text: current?.id === target.id ? current.text : '' }));
  }, []);
  const change = useCallback((text: string) => setComment(current => current && { ...current, text }), []);
  const submit = async () => {
    if (!comment?.text.trim() || submitting.current) return;
    submitting.current = true; setBusy(true);
    try { await comment.reject(comment.text.trim()); }
    catch { /* The action callback reports its error; retain the comment for retry. */ }
    finally { submitting.current = false; setBusy(false); }
    // Removal of the resolved request clears this mode in ChatPage.
  };
  const registerReject = useCallback((id: string, reject: ConfirmationComment['reject']) => { rejectHandlers.current.set(id, reject); return () => { if (rejectHandlers.current.get(id) === reject) rejectHandlers.current.delete(id); }; }, []);
  return { comment, request, change, cancel, submit, busy, registerReject };
}
