import React from 'react';
import { createRoot } from 'react-dom/client';
import './global.scss';
import { App } from './App';
import { initializeI18n } from './i18n';

async function bootstrap() {
  await initializeI18n();

  const rootEl = document.getElementById('root');
  if (rootEl) {
    const root = createRoot(rootEl);
    root.render(<App />);
  }
}

void bootstrap();
