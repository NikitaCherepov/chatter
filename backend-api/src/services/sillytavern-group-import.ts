import path from 'node:path';
import { db } from '../db.js';
import { addChatAgent, createChatRoom, updateChatRoomSettings } from './chat-rooms.js';
import { importSillyTavernChats, previewSillyTavernChats } from './sillytavern-chat-import.js';
import { chatMediaRows } from './sillytavern-chat-media.js';

type File = { name: string; data: Buffer };
export type GroupHistory = { file: File; group: any; scope: string; title: string; root: string; warnings: string[] };
export type GroupCard = { root: string; key: string; promptId: number; name: string };
const rootOf = (name: string, folder: string) => name.slice(0, name.toLowerCase().lastIndexOf('/' + folder.toLowerCase() + '/') + 1);
export function planGroupHistories(groups: File[], histories: File[]): GroupHistory[] {
  const definitions = groups.map(file => {
    let group: any;
    try { group = JSON.parse(file.data.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('sillytavern_backup_invalid_group'); }
    if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.members)
      || group.members.length > 500 || group.members.some((item: any) => typeof item !== 'string')
      || (group.chats !== undefined && (!Array.isArray(group.chats) || group.chats.some((item: any) => typeof item !== 'string')))) throw new Error('sillytavern_backup_invalid_group');
    group.members = [...new Set(group.members)];
    return { group, root: rootOf(file.name, 'groups'), key: path.posix.basename(file.name, '.json') };
  });
  return histories.map(file => {
    const root = rootOf(file.name, 'group chats');
    const id = path.posix.basename(file.name, '.jsonl');
    const matches = definitions.filter(item => item.root === root && (item.group.chat_id === id || item.group.chats?.includes(id)));
    if (matches.length > 1) throw new Error('sillytavern_backup_ambiguous_group');
    const match = matches[0];
    const group = match?.group || { id, name: id, members: [] };
    const identityRoot = root.split('/').filter(Boolean).at(-1) || 'default';
    return { file, group, root, scope: 'sillytavern-group:' + identityRoot + ':' + (group.id || match?.key || id) + ':' + id, title: String(group.name || id).slice(0, 90) + ' · ' + id.slice(0, 25), warnings: match ? ['group_behavior_changed'] : ['group_metadata_missing', 'group_behavior_changed'] };
  });
}
export function previewGroupHistory(userId: number, task: GroupHistory) {
  return previewSillyTavernChats(userId, [{ file_name: task.file.name, base64: task.file.data.toString('base64') }], { sourceScope: task.scope })[0];
}
function resolveCard(cards: Array<{ root: string; key: string }>, task: GroupHistory, key: string) {
  const normalized = key.replace(/\\/g, '/');
  const candidates = cards.filter(card => card.root === task.root && (card.key === normalized || path.posix.basename(card.key, path.posix.extname(card.key)) === path.posix.basename(normalized, path.posix.extname(normalized))));
  return candidates.length === 1 ? candidates[0] : null;
}
export function importGroupHistory(userId: number, task: GroupHistory, cards: GroupCard[]) {
  return db.transaction(() => {
    const [chat] = importSillyTavernChats(userId, [{ file_name: task.file.name, base64: task.file.data.toString('base64') }], { sourceScope: task.scope });
    // Preserve edited room settings and message attribution on repeat imports.
    if (chat.status === 'existing') {
      const unresolved = Boolean(db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND agent_id IS NULL LIMIT 1").get(chat.chat_id));
      return { chat, warnings: [...task.warnings, ...(unresolved ? ['group_character_missing'] : [])] };
    }
    db.prepare('UPDATE user_chats SET default_prompt_id = NULL WHERE id = ?').run(chat.chat_id);
    db.prepare("UPDATE chat_messages SET prompt_id = NULL WHERE chat_id = ? AND role = 'assistant'").run(chat.chat_id);
    db.prepare('UPDATE chat_message_variants SET prompt_id = NULL WHERE message_id IN (SELECT id FROM chat_messages WHERE chat_id = ?)').run(chat.chat_id);
    const matches = (task.group.members as string[]).map(key => ({ key, card: resolveCard(cards, task, key) as GroupCard | null }));
    const found = matches.filter(item => item.card);
    const agents = new Map<string, { id: number; promptId: number; name: string }>();
    if (found.length) {
      db.prepare('UPDATE user_chats SET default_prompt_id = ? WHERE id = ? AND user_id = ?').run(found[0].card!.promptId, chat.chat_id, userId);
      let room = createChatRoom(userId, chat.chat_id);
      found.forEach((member, index) => {
        if (index) room = addChatAgent(userId, chat.chat_id, member.card!.promptId, member.card!.name);
        const agent = room.agents[room.agents.length - 1];
        agents.set(member.key, { id: agent.id, promptId: member.card!.promptId, name: member.card!.name });
      });
      updateChatRoomSettings(userId, chat.chat_id, { responseMode: 'manual', autoRespond: false });
    } else {
      db.prepare('UPDATE user_chats SET room_enabled = 1 WHERE id = ? AND user_id = ?').run(chat.chat_id, userId);
      db.prepare("INSERT INTO chat_members (chat_id, user_id, role, response_mode, auto_respond, sort_order) VALUES (?, ?, 'admin', 'manual', 0, 0)").run(chat.chat_id, userId);
    }
    db.prepare('UPDATE user_chats SET title = ? WHERE id = ? AND user_id = ?').run(task.title, chat.chat_id, userId);
    const rows = chatMediaRows(task.file.data.toString('utf8'));
    const messages = db.prepare('SELECT id, role FROM chat_messages WHERE user_id = ? AND chat_id = ? ORDER BY timeline_index, id').all(userId, chat.chat_id) as Array<{ id: number; role: string }>;
    let missing = matches.some(item => !item.card);
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'assistant') continue;
      const row = rows[i];
      let agent = typeof row.original_avatar === 'string' ? agents.get(row.original_avatar) : undefined;
      if (!row.original_avatar) {
        const named = [...agents.values()].filter(item => item.name === row.name);
        if (named.length === 1) agent = named[0];
      }
      if (!agent) { missing = true; continue; }
      db.prepare('UPDATE chat_messages SET agent_id = ?, prompt_id = ? WHERE id = ?').run(agent.id, agent.promptId, messages[i].id);
      db.prepare('UPDATE chat_message_variants SET agent_id = ?, prompt_id = ? WHERE message_id = ?').run(agent.id, agent.promptId, messages[i].id);
    }
    return { chat, warnings: [...task.warnings, ...(missing ? ['group_character_missing'] : [])] };
  })();
}
export function groupCardRoot(fileName: string) { return rootOf(fileName, 'characters'); }
export function missingGroupCards(task: GroupHistory, cards: Array<{ root: string; key: string }>) {
  return (task.group.members as string[]).some(key => !resolveCard(cards, task, key));
}
