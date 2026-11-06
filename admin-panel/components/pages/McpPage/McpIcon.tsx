const paths: Record<string, string> = {
  chevron: 'm9 5 7 7-7 7',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18',
  monitor: 'M3 3h18v13H3z M8 21h8 M12 16v5',
  search: 'M20 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M17 17l5 5',
  plus: 'M12 5v14 M5 12h14',
  code: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  book: 'M12 5c-3-2-6-2-10-1v16c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1z M12 5v16',
};
export function McpIcon({ name }: { name: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.globe} />
    </svg>
  );
}
