import type { ToolCall } from './api';

export type ActivityKind = 'search' | 'note' | 'file' | 'terminal' | 'browser' | 'clock' | 'avatar' | 'tool';
export type ToolActivity = {
  call: ToolCall; kind: ActivityKind; target: string; confirmed: boolean;
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
  const kinds: Partial<Record<ActivityKind, string[]>> = {
    search: ['web_search','search_web','search_file_keywords','search_attachment_file','search_chat_history','search_cold_memory','search_nearby'],
    browser: ['web_reader','read_webpage','browser_control'],
    note: ['save_note','list_my_notes','read_note','delete_note'],
    file: ['read_file','write_file','edit_file_lines','explore_fs','get_file_info','list_directory','read_attachment_file','attach_file_to_response','generate_image','image_gen','create_pixel_image','describe_image','capture_screen','capture_webcam','convert_video'],
    terminal: ['execute_pc_command','execute_ssh_command','execute_macro','install_ssh_public_key','create_server_user','change_server_user_password'],
    clock: ['get_user_time','set_user_timezone','schedule_task','create_task','get_my_tasks','update_my_task','delete_my_task','finish_task'],
    avatar: ['set_display_state','get_avatar_state','set_avatar_mood','set_avatar_emotion'],
  };
  for (const [category, names] of Object.entries(kinds)) {
    if (names?.includes(name)) { kind = category as ActivityKind; break; }
  }
  const confirmed = name === 'save_note' && !failed && /^Note saved:\s*#\d+/i.test(text);
  const target = [args.title, args.query, args.url, args.path, args.file_path, args.filename, args.command, args.target, args.agent]
    .find(value => typeof value === 'string' && value.trim()) ?? '';
  return { call, kind, confirmed, target: String(target).slice(0, 240), internal,
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
