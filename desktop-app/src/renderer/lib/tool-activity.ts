import type { ToolCall } from './api';

export type ActivityKind = 'search' | 'note' | 'file' | 'terminal' | 'browser' | 'clock' | 'avatar' | 'tool';
export type ToolActivity = {
  call: ToolCall; kind: ActivityKind; label: string; target: string;
  status: 'error' | 'returned' | 'unknown'; internal: boolean;
};

export function toolValue(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return value == null ? '' : JSON.stringify(value, null, 2);
}

export function describeToolCall(call: ToolCall): ToolActivity {
  let args = call.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  args = args && typeof args === 'object' ? args : {};
  const text = toolValue(call.result_preview).trim();
  let result: any;
  try { result = JSON.parse(text); } catch { /* Older results can be plain or truncated text. */ }
  const failed = Boolean(result && typeof result === 'object' && !Array.isArray(result)
    && (result.error || result.ok === false || result.success === false || ['error', 'failed'].includes(result.status)))
    || /^(?:tool\s+error\b|error\s*:|ошибка\s*:)/i.test(text)
    || /^Tool .+ is disabled by current restriction settings\./.test(text)
    || /^\s*\{[\s\S]*?"(?:ok|success)"\s*:\s*false/.test(text)
    || /^\s*\{\s*"error"\s*:\s*(?!null\b|false\b|""\s*[,}])\S/.test(text);
  const name = call.name;
  const internal = ['set_display_state', 'set_avatar_mood', 'set_avatar_emotion'].includes(name);
  let kind: ActivityKind = 'tool';
  let label = name.replace(/_/g, ' ');
  const labels: Record<string, [ActivityKind, string]> = {
    web_search: ['search', 'search'], search_web: ['search', 'search'],
    web_reader: ['browser', 'readPage'], read_webpage: ['browser', 'readPage'],
    save_note: ['note', /^Note saved:\s*#\d+/i.test(text) ? 'noteSaved' : 'saveNote'],
    list_my_notes: ['note', 'listNotes'], read_note: ['note', 'readNote'], delete_note: ['note', 'deleteNote'],
    read_file: ['file', 'readFile'], write_file: ['file', 'writeFile'], edit_file_lines: ['file', 'editFile'],
    search_file_keywords: ['search', 'searchFiles'], explore_fs: ['file', 'listFiles'],
    execute_pc_command: ['terminal', 'command'], execute_ssh_command: ['terminal', 'ssh'], execute_macro: ['terminal', 'macro'],
    browser_control: ['browser', 'browser'], desktop_action: ['tool', 'desktop'],
    create_task: ['clock', 'task'], image_gen: ['file', 'image'], generate_image: ['file', 'image'],
    spawn_subagent: ['tool', 'agent'], invoke_subagent: ['tool', 'agent'],
    set_display_state: ['avatar', 'avatar'], set_avatar_mood: ['avatar', 'avatar'], set_avatar_emotion: ['avatar', 'avatar'],
  };
  if (labels[name]) [kind, label] = labels[name];
  const target = [args.title, args.query, args.url, args.path, args.file_path, args.filename, args.command, args.target, args.agent]
    .find(value => typeof value === 'string' && value.trim()) ?? '';
  return { call, kind, label, target: String(target).slice(0, 240), internal,
    status: failed ? 'error' : text ? 'returned' : 'unknown' };
}

export function groupToolActivities(calls: ToolCall[]) {
  const rows = calls.map(describeToolCall);
  const publicRows = rows.filter(row => !row.internal || row.status === 'error');
  let ordinary = 0;
  const visible = publicRows.filter(row => row.status === 'error' || ordinary++ < 3);
  const shown = new Set(visible);
  return { visible, more: publicRows.filter(row => !shown.has(row)),
    internal: rows.filter(row => row.internal && row.status !== 'error') };
}
