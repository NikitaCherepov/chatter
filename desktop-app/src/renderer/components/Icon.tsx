import React from 'react';

const PATHS = {
  mail: 'M3 4h18v16H3z M3 5l9 7 9-7',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  database: 'M20 5c0 2-4 3-8 3S4 7 4 5s4-3 8-3 8 1 8 3z M4 5v14c0 2 4 3 8 3s8-1 8-3V5 M4 12c0 2 4 3 8 3s8-1 8-3',
  monitor: 'M3 3h18v13H3z M8 21h8 M12 16v5',
  lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  avatar: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2 M7 8v2 M17 8v2 M8 15c2 2 6 2 8 0',
  agent: 'M8 8h8v8H8z M12 3v5 M3 12h5 M16 12h5 M12 16v5 M10 3h4 M3 10v4 M21 10v4 M10 21h4',
  search: 'M20 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M17 17l5 5',
  file: 'M7 3h8l4 4v14H5V3h2 M14 3v5h5 M8 13h8m-3-3 3 3-3 3',
  code: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  terminal: 'M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18',
  pointer: 'm4 3 7 18 3-7 7-3L4 3z M14 14l6 6',
  text: 'M4 5h16 M12 5v14 M8 19h8 M4 5v3 M20 5v3',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  key: 'M14 9a5 5 0 1 1-10 0 5 5 0 0 1 10 0 M12.5 12.5 21 21 M17 17l3-3 M19 19l3-3',
  book: 'M12 5c-3-2-6-2-10-1v16c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1z M12 5v16',
  calendar: 'M3 5h18v16H3z M7 2v6 M17 2v6 M3 11h18',
} as const;

/** Resolve server-supplied icon names locally; unknown names use the agent icon. */
export function Icon({ name, size = 18, className }: { name?: string | null; size?: number; className?: string }) {
  const path = name && Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name as keyof typeof PATHS] : PATHS.agent;
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
