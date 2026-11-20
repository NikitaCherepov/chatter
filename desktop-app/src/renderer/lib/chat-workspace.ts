import { useCallback, useEffect, useMemo, useState } from 'react';

export type WorkspaceTab = { id: number; title: string; pinned: boolean };

type Workspace = { tabs: WorkspaceTab[]; tools: string[] };

const defaultWorkspace: Workspace = { tabs: [], tools: ['notebook', 'tasks'] };
export const MAX_TOOL_FAVORITES = 3;

function readWorkspace(key: string): Workspace {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!raw || typeof raw !== 'object') return defaultWorkspace;
    const tabs = new Map<number, WorkspaceTab>();
    for (const tab of Array.isArray(raw.tabs) ? raw.tabs : []) {
      if (!tab || !Number.isSafeInteger(tab.id) || tab.id <= 0 || typeof tab.title !== 'string') continue;
      tabs.set(tab.id, { id: tab.id, title: tab.title, pinned: tab.pinned === true });
    }
    const tools = Array.isArray(raw.tools)
      ? [...new Set<string>(raw.tools.filter((id: unknown): id is string => typeof id === 'string'))].slice(0, MAX_TOOL_FAVORITES)
      : defaultWorkspace.tools;
    return { tabs: [...tabs.values()], tools };
  } catch {
    return defaultWorkspace;
  }
}

export function useChatWorkspace(
  scope: string,
  activeId: number | null,
  chats: readonly { id: number; title: string }[],
  tabsEnabled: boolean,
) {
  const key = 'chatter_workspace:' + scope;
  const initial = useMemo(() => readWorkspace(key), [key]);
  const [saved, setSaved] = useState(() => ({ key, value: initial }));
  const workspace = saved.key === key ? saved.value : initial;

  const update = useCallback((change: (value: Workspace) => Workspace) => {
    setSaved(previous => {
      const current = previous.key === key ? previous.value : initial;
      const value = change(current);
      return value === current && previous.key === key ? previous : { key, value };
    });
  }, [key, initial]);

  useEffect(() => {
    if (saved.key !== key) return;
    try { localStorage.setItem(key, JSON.stringify(saved.value)); } catch { /* Storage can be unavailable. */ }
  }, [saved, key]);

  useEffect(() => {
    update(current => {
      let changed = false;
      const tabs = current.tabs.map(tab => {
        const title = chats.find(chat => chat.id === tab.id)?.title;
        if (!title || title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      if (tabsEnabled && activeId !== null && !tabs.some(tab => tab.id === activeId)) {
        const title = chats.find(chat => chat.id === activeId)?.title ?? '';
        tabs.push({ id: activeId, title, pinned: false });
        changed = true;
      }
      return changed ? { ...current, tabs } : current;
    });
  }, [activeId, chats, tabsEnabled, update]);

  const tabs = useMemo(() => [
    ...workspace.tabs.filter(tab => tab.pinned),
    ...workspace.tabs.filter(tab => !tab.pinned),
  ], [workspace.tabs]);

  return {
    tabs,
    tools: workspace.tools,
    removeTab: (id: number) => update(current => current.tabs.some(tab => tab.id === id)
      ? { ...current, tabs: current.tabs.filter(tab => tab.id !== id) } : current),
    togglePin: (id: number) => update(current => ({
      ...current, tabs: current.tabs.map(tab => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab),
    })),
    setFavorite: (id: string, favorite: boolean) => update(current => {
      const tools = current.tools.filter(tool => tool !== id);
      if (favorite && tools.length >= MAX_TOOL_FAVORITES) return current;
      return { ...current, tools: favorite ? [...tools, id] : tools };
    }),
  };
}
