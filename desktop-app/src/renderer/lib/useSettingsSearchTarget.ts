import { useEffect, useRef, useState } from 'react';
import {
  normalizeSettingsSearch,
  settingsSectionKey,
  type SettingsSearchResult,
  type SettingsSection,
} from './settings-navigation';

/** Observe only the selected settings panel: async forms may mount after navigation. */
export function useSettingsSearchTarget(section: SettingsSection) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<{ result: SettingsSearchResult; serial: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const root = panelRef.current;
    setUnavailable(false);
    if (!root || !request || request.result.section !== section) return;
    const { result } = request;
    if (result.key === settingsSectionKey(section)) {
      root.querySelectorAll<HTMLElement>('*').forEach((el) => {
        if (el.scrollTop) el.scrollTop = 0;
      });
      return;
    }
    let animation: Animation | undefined;
    let done = false;
    let timeout: ReturnType<typeof setTimeout>;
    let frame: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(frame);
      frame = setTimeout(find, 0);
    };
    const observer = new MutationObserver(schedule);
    function find() {
      if (!root || done) return;
      const title = normalizeSettingsSearch(result.title);
      const elements = Array.from(root.querySelectorAll<HTMLElement>('label, span, div, p, h2, h3, h4'));
      const target = elements.find(
        (el) =>
          el.getClientRects().length &&
          normalizeSettingsSearch(el.textContent ?? '') === title &&
          !Array.from(el.children).some((child) => normalizeSettingsSearch(child.textContent ?? '') === title)
      );
      if (!target) return;
      done = true;
      setUnavailable(false);
      observer.disconnect();
      clearTimeout(timeout);
      const field = target.closest<HTMLElement>('[data-settings-field], label') ?? target;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      field.scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
      // Highlight only; do not focus inputs or trigger their save-on-blur handlers.
      animation = field.animate(
        [
          { outline: '2px solid var(--accent)', outlineOffset: '5px', backgroundColor: 'var(--bg-input)' },
          { outline: '2px solid transparent', outlineOffset: '5px', backgroundColor: 'transparent' },
        ],
        { duration: reduced ? 1 : 1800, easing: 'ease-out' }
      );
    }
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    timeout = setTimeout(() => {
      if (!done) setUnavailable(true);
    }, 4000);
    schedule();
    return () => {
      observer.disconnect();
      clearTimeout(frame);
      clearTimeout(timeout);
      animation?.cancel();
    };
  }, [request, section]);
  const selectTarget = (result?: SettingsSearchResult) => {
    setUnavailable(false);
    setRequest(result ? { result, serial: Date.now() } : null);
  };
  return { panelRef, selectTarget, unavailable };
}
