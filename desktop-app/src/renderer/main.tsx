import React from 'react';
import { createRoot } from 'react-dom/client';
import './global.scss';
import { App } from './App';
import { ToolWindowApp } from './ToolWindowApp';
import { initializeI18n } from './i18n';
import { initializeTheme } from './lib/theme';
import { QueryProvider } from './lib/QueryProvider';

async function bootstrap() {
  initializeTheme();
  await initializeI18n();

  const rootEl = document.getElementById('root');
  if (rootEl) {
    const root = createRoot(rootEl);
    const isToolWindow = new URLSearchParams(window.location.search).has('toolWindow');
    root.render(
      <QueryProvider>
        {isToolWindow ? <ToolWindowApp /> : <App />}
      </QueryProvider>,
    );
  }
}

void bootstrap();
