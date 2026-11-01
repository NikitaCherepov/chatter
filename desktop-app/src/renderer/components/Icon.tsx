import React from 'react';

const PATHS = {
  agent: 'M8 8h8v8H8z M12 3v5 M3 12h5 M16 12h5 M12 16v5 M10 3h4 M3 10v4 M21 10v4 M10 21h4',
  search: 'M20 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M17 17l5 5',
  file: 'M7 3h8l4 4v14H5V3h2 M14 3v5h5 M8 13h8m-3-3 3 3-3 3',
  code: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  terminal: 'M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18',
  book: 'M12 5c-3-2-6-2-10-1v16c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1z M12 5v16',
  calendar: 'M3 5h18v16H3z M7 2v6 M17 2v6 M3 11h18',
} as const;

/** Resolve server-supplied icon names locally; unknown names use the agent icon. */
export function Icon({ name, size = 18, className }: { name?: string | null; size?: number; className?: string }) {
  const path = name && Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name as keyof typeof PATHS] : PATHS.agent;
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
