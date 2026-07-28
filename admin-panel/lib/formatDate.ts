export function formatDateTime(
  value: string | number | null | undefined,
  locale: string,
): string {
  if (value === null || value === undefined || value === '') return '—';

  const normalized = typeof value === 'number'
    ? value
    : value.includes('T')
      ? value
      : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
