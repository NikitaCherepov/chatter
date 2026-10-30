/** Aggregate timestamps into local calendar days, including historical DST offsets. */
export function countActivityDays(rows: Array<{ timestamp: number; count: number }>, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const parts = formatter.formatToParts(new Date(row.timestamp * 1000));
    const get = (type: string) => parts.find(part => part.type === type)!.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    counts[day] = (counts[day] || 0) + row.count;
  }
  return counts;
}
