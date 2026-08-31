import React, { useEffect, useMemo, useState } from 'react';
import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ToolContent } from './components/ToolContent';
import s from './ToolWindowApp.module.scss';

const CONTENT_LIMITS: Record<string, number> = {
  free: 400,
  standart: 800,
  pro: 3000,
};

const TOOL_TITLE_KEYS: Record<string, string> = {
  notebook: 'tools.panel.notebook',
  tasks: 'tools.panel.tasks',
  map: 'tools.panel.map',
  gallery: 'tools.panel.gallery',
  documents: 'tools.panel.documents',
  browser: 'tools.panel.browser',
  'json-extractor': 'tools.panel.jsonExtractor',
};

export function ToolWindowApp() {
  const { t } = useTranslation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const toolId = params.get('toolWindow') || '';
  const activeChatIdValue = Number(params.get('activeChatId'));
  const [activeChatId, setActiveChatId] = useState<number | null>(
    Number.isInteger(activeChatIdValue) && activeChatIdValue > 0 ? activeChatIdValue : null,
  );
  const storedUser = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('chatter_user') || 'null') as { plan?: string; is_admin?: number } | null;
    } catch {
      return null;
    }
  }, []);
  const contentMax = storedUser?.is_admin === 1 ? 3000 : (CONTENT_LIMITS[storedUser?.plan || 'free'] || 400);
  const title = TOOL_TITLE_KEYS[toolId] ? t(TOOL_TITLE_KEYS[toolId]) : (params.get('title') || 'Chatter');

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => window.electronAPI.onToolWindowContext((context) => {
    setActiveChatId(typeof context.activeChatId === 'number' ? context.activeChatId : null);
  }), []);

  const dock = () => {
    void window.electronAPI.dockToolWindow(toolId);
  };

  return (
    <div className={s.shell}>
      <header className={s.header}>
        <strong className={s.title}>{title}</strong>
        <button type="button" className={s.dockButton} onClick={dock} title={t('widget.toSidebar')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span>{t('widget.toSidebar')}</span>
        </button>
      </header>
      <main className={s.body}>
        <ToolContent toolId={toolId} contentMax={contentMax} activeChatId={activeChatId} />
      </main>
      <Toaster position="top-right" richColors closeButton />
    </div>
  );
}
