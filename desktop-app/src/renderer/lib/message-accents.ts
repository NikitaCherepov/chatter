/** Canonical source. Run scripts/sync-message-accents.mjs after editing. */
export const MESSAGE_ACCENT_STYLES = [
  'muted', 'caption', 'underline', 'info', 'success', 'warning', 'error',
  'highlight-info', 'highlight-success', 'highlight-warning', 'highlight-error',
  'badge-info', 'badge-success', 'badge-warning', 'badge-error',
] as const;

export type MessageAccentStyle = typeof MESSAGE_ACCENT_STYLES[number];
const styles = new Set<string>(MESSAGE_ACCENT_STYLES);

export type MessageLayoutTag = {
  name: 'grid' | 'flex' | 'box';
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
};

/** A small declarative grammar, not HTML/JSX. Unknown attributes reject the tag. */
export function parseMessageLayoutTag(source: string): MessageLayoutTag | null {
  if (source.length > 400) return null;
  const tag = /^<(\/?)(grid|flex|box)\b([^<>]*?)(\/?)>$/.exec(source.trim());
  if (!tag || (tag[1] && (tag[3].trim() || tag[4]))) return null;
  const name = tag[2] as MessageLayoutTag['name'];
  const attributes: Record<string, string> = {};
  let rest = tag[3];
  while (rest.trim()) {
    const attr = /^\s+([a-z]+)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'))?/.exec(rest);
    if (!attr || Object.prototype.hasOwnProperty.call(attributes, attr[1])) return null;
    const key = attr[1], value = attr[2] ?? attr[3] ?? '';
    const valid = key === 'border' ? value === ''
      : key === 'columns' ? name === 'grid' && /^[1-4]$/.test(value)
      : key === 'gap' || key === 'padding' ? /^[0-6]$/.test(value)
      : key === 'radius' ? /^(none|sm|md|lg|xl)$/.test(value)
      : key === 'background' ? /^(surface|muted|info|success|warning|error|#[0-9a-fA-F]{6})$/.test(value)
      : key === 'direction' ? name === 'flex' && /^(row|column)$/.test(value)
      : key === 'wrap' ? name === 'flex' && /^(yes|no)$/.test(value)
      : key === 'align' ? /^(start|center|end|stretch)$/.test(value)
      : key === 'justify' ? name === 'flex' && /^(start|center|end|between)$/.test(value)
      : false;
    if (!valid) return null;
    attributes[key] = value;
    rest = rest.slice(attr[0].length);
  }
  return { name, closing: !!tag[1], selfClosing: !!tag[4], attributes };
}

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
  if (!source.includes('](style') && !(stripComplete && (source.includes('layout:') || source.includes('questionnaire')))
    && !/<\/?(?:grid|flex|box)\b/.test(source)) return source;
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
        let literal = source.slice(index, stop);
        // Telegram/plain fallback only. No new bot runtime dependency or executable markup.
        if (stripComplete && closing && /^ {0,3}(?:`{3,}|~{3,})questionnaire[ \t]*\r?\n/.test(fence[0])) {
          try {
            const form = JSON.parse(source.slice(index + fence[0].length, closing.index));
            if (typeof form.title === 'string' && Array.isArray(form.questions) && form.questions.length <= 100
              && form.questions.every((q: any) => typeof q?.label === 'string' && ['single', 'multiple', 'text', 'textarea'].includes(q.type)
                && (q.options === undefined || (Array.isArray(q.options) && q.options.length <= 32 && q.options.every((v: any) => typeof v === 'string'))))) {
              literal = form.title + '\n\n' + form.questions.map((q: any, n: number) => `${n + 1}. ${q.label}${q.required ? ' *' : ''}`
                + (typeof q.image?.url === 'string' && q.image.url.length <= 2048 && /^(?:https?:\/\/|\/(?!\/))/.test(q.image.url) && !/[\s\\\u0000-\u001f\u007f]/u.test(q.image.url) ? '\nImage: ' + q.image.url : '')
                + (q.options?.length ? '\n' + q.options.map((o: string) => `- ${o}`).join('\n') : '')
                + (q.allowOther === true && (q.type === 'single' || q.type === 'multiple') ? '\n- Other (free text)' : '')).join('\n\n') + '\n';
            }
          } catch { /* Invalid JSON stays literal code. */ }
        }
        result += literal;
        index = stop;
        continue;
      }
      // Standalone tags get blank lines so Markdown inside containers stays Markdown.
      const layoutLine = /^ {0,3}(<\/?(?:grid|flex|box)\b[^\r\n]*>)[ \t]*(?:\r?\n|$)/.exec(source.slice(index));
      if (layoutLine && parseMessageLayoutTag(layoutLine[1])) {
        result += stripComplete ? '\n' : `\n\n${layoutLine[1]}\n\n`;
        index += layoutLine[0].length;
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
