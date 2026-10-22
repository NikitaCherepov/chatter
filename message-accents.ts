/** Canonical source. Run scripts/sync-message-accents.mjs after editing. */
export const MESSAGE_ACCENT_STYLES = [
  'muted', 'caption', 'underline', 'info', 'success', 'warning', 'error',
  'highlight-info', 'highlight-success', 'highlight-warning', 'highlight-error',
  'badge-info', 'badge-success', 'badge-warning', 'badge-error',
] as const;

export type MessageAccentStyle = typeof MESSAGE_ACCENT_STYLES[number];
const styles = new Set<string>(MESSAGE_ACCENT_STYLES);

export function getMessageAccentStyle(url: string): MessageAccentStyle | null {
  const style = url.startsWith('style:') ? url.slice(6) : '';
  return styles.has(style) ? style as MessageAccentStyle : null;
}

/** Plain Markdown fallback, including image layout titles. Code stays literal. */
export function stripMessageAccents(source: string): string {
  return transformMessageAccents(source, true);
}

/** Hide an unfinished style destination while tokens are arriving. */
export function prepareMessageAccents(source: string): string {
  return transformMessageAccents(source, false);
}

function transformMessageAccents(source: string, stripComplete: boolean): string {
  if (!source.includes('](style') && !(stripComplete && source.includes('layout:'))) return source;
  let result = '';
  let index = 0;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(index));
      if (fence) {
        const end = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
        end.lastIndex = index + fence[0].length;
        const closing = end.exec(source);
        const stop = closing ? end.lastIndex : source.length;
        result += source.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (source[index] === '\\') {
      result += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (source[index] === '`') {
      const delimiter = /^`+/.exec(source.slice(index))![0];
      const runs = /`+/g;
      runs.lastIndex = index + delimiter.length;
      let match: RegExpExecArray | null;
      let stop = 0;
      while ((match = runs.exec(source))) {
        if (match[0].length === delimiter.length) { stop = runs.lastIndex; break; }
      }
      if (stop) {
        result += source.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (stripComplete && source.startsWith('![', index)) {
      const image = /^(!\[(?:\\.|[^\]\\\r\n])*\]\((?:<[^<>\r\n]+>|[^\s\r\n]+?))[ \t]+(?:"layout:(?:side|gallery)"|'layout:(?:side|gallery)'|\(layout:(?:side|gallery)\))[ \t]*\)/.exec(source.slice(index));
      if (image) {
        result += `${image[1]})`;
        index += image[0].length;
        continue;
      }
    }
    if (source[index] === '[') {
      let depth = 1;
      let end = index + 1;
      for (; end < source.length && source[end] !== '\n'; end++) {
        if (source[end] === '\\') { end++; continue; }
        if (source[end] === '[') depth++;
        if (source[end] === ']' && --depth === 0) break;
      }
      const suffix = depth === 0 ? /^\]\((style:[a-z-]+)\)/.exec(source.slice(end)) : null;
      if (suffix && getMessageAccentStyle(suffix[1])) {
        result += stripComplete ? source.slice(index + 1, end) : source.slice(index, end + suffix[0].length);
        index = end + suffix[0].length;
        continue;
      }
      const pending = depth === 0 ? /^\]\(style(?::([a-z-]*))?$/.exec(source.slice(end)) : null;
      if (pending && MESSAGE_ACCENT_STYLES.some(style => style.startsWith(pending[1] || ''))) {
        result += source.slice(index + 1, end);
        index = source.length;
        continue;
      }
    }
    result += source[index++];
  }
  return result;
}
