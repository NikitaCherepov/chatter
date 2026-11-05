import React, { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { API_BASE, onMcpSettingsUpdated, onBackendRestored } from './api';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(
    () =>
      onBackendRestored(() => {
        void client.invalidateQueries();
      }),
    [client],
  );

  useEffect(
    () =>
      onMcpSettingsUpdated(() => {
        void client.invalidateQueries({
          queryKey: ['settings', API_BASE],
          predicate: (query) => query.queryKey[3] === 'mcp',
        });
      }),
    [client],
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
