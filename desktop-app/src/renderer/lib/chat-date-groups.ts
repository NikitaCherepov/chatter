type DatedChat = { created_at: number; updated_at?: number };
export type ChatDateGroup<T> = { key: string; month?: Date; chats: T[] };

/** Local calendar boundaries, not fixed 24-hour offsets (which break across DST). */
export function groupChatsByActivity<T extends DatedChat>(chats: T[], now = new Date()): ChatDateGroup<T>[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const groups = new Map<string, ChatDateGroup<T>>();
  for (const chat of chats) {
    const time = (chat.updated_at || chat.created_at) * 1000;
    const date = new Date(time);
    const key = time >= +today ? 'today' : time >= +yesterday ? 'yesterday'
      : time >= +week ? 'thisWeek' : time >= +month ? 'thisMonth'
      : Number.isFinite(time) ? `month:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : 'older';
    let group = groups.get(key);
    if (!group) {
      group = { key, chats: [], ...(key.startsWith('month:') ? { month: new Date(date.getFullYear(), date.getMonth(), 1) } : {}) };
      groups.set(key, group);
    }
    group.chats.push(chat);
  }
  const recent = ['today', 'yesterday', 'thisWeek', 'thisMonth'];
  return [...groups.values()].sort((a, b) => {
    const ai = recent.indexOf(a.key), bi = recent.indexOf(b.key);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 4 : ai) - (bi < 0 ? 4 : bi);
    return +(b.month || 0) - +(a.month || 0);
  });
}

export function activityDay(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function moveActivityCount(counts: Record<string, number>, from: string, to: string): Record<string, number> {
  if (from === to) return counts;
  return { ...counts, [from]: Math.max(0, (counts[from] || 0) - 1), [to]: (counts[to] || 0) + 1 };
}

export function activityGroupCounts(days: Record<string, number>, now = new Date()): Record<string, number> {
  const entries = Object.entries(days).map(([day, count]) => {
    const [year, month, date] = day.split('-').map(Number);
    return { created_at: +new Date(year, month - 1, date, 12) / 1000, count };
  });
  return Object.fromEntries(groupChatsByActivity(entries, now).map(group => [group.key, group.chats.reduce((sum, item) => sum + item.count, 0)]));
}
