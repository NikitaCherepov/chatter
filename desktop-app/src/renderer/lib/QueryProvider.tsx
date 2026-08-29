import React, { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { onBackendRestored } from './api';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  }));

  useEffect(() => onBackendRestored(() => {
    void client.invalidateQueries();
  }), [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
