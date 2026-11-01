export type SubagentPromptDocument = {
  body: string;
  metadata?: { nameKey: string; descriptionKey: string; icon?: string };
};

/** Flat metadata header: dictionary keys and an optional icon name, never prompt instructions. */
export function parseSubagentPrompt(source: string): SubagentPromptDocument {
  const text = source.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(text)) return { body: text };
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) throw new Error('Unclosed subagent prompt metadata');
  const keys: Record<string, string> = {};
  for (const line of header[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(name_key|description_key|icon):\s*(['"]?)([A-Za-z0-9_.-]+)\2\s*$/.exec(line.trim());
    if (!match || keys[match[1]]) throw new Error(`Invalid subagent prompt metadata: ${line}`);
    keys[match[1]] = match[3];
  }
  if (!keys.name_key || !keys.description_key) throw new Error('Subagent prompt metadata requires name_key and description_key');
  return {
    metadata: { nameKey: keys.name_key, descriptionKey: keys.description_key, ...(keys.icon ? { icon: keys.icon } : {}) },
    body: text.slice(header[0].length).replace(/^\r?\n/, ''),
  };
}
