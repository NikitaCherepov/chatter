export function startsMessageDay(timestamp: number, previous?: number): boolean {
  if (previous === undefined) return true;
  const current = new Date(timestamp * 1000), before = new Date(previous * 1000);
  return current.getFullYear() !== before.getFullYear() || current.getMonth() !== before.getMonth() || current.getDate() !== before.getDate();
}
export function messageClock(timestamp: number, locale?: string): string {
  return new Date(timestamp * 1000).toLocaleTimeString(locale, {hour:'2-digit',minute:'2-digit',hour12:false});
}
export function messageDate(timestamp: number, locale?: string, now = new Date()): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(locale, {day:'numeric',month:'long',...(date.getFullYear() !== now.getFullYear() ? {year:'numeric'} : {})});
}
export function fullMessageDate(timestamp: number, locale?: string): string {
  return new Date(timestamp * 1000).toLocaleString(locale, {day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZoneName:'short'});
}
