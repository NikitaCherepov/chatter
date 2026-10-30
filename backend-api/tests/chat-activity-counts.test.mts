import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
process.env.API_DB_PATH = path.join(os.tmpdir(), `chatter-activity-counts-${process.pid}-${Date.now()}.sqlite`);
const { db } = await import('../src/db.js');
const { getUnfiledActivityCounts, listUserChats, createChatFolder, moveUserChatToFolder } = await import('../src/services/chats.js');
const { countActivityDays } = await import('../src/services/chat-activity-counts.js');
const stamp = (value: string) => Date.parse(value) / 1000;
assert.deepEqual(countActivityDays([{timestamp:stamp('2026-10-29T18:00:00Z'),count:2}], 'Asia/Tomsk'), {'2026-10-30':2});
assert.deepEqual(countActivityDays([
  {timestamp:stamp('2026-11-01T05:30:00Z'),count:1},
  {timestamp:stamp('2026-11-01T06:30:00Z'),count:1},
], 'America/New_York'), {'2026-11-01':2}, 'DST repeated hour counts once per chat');
assert.throws(()=>countActivityDays([], 'Invalid/Zone'));
for (const id of [101,202,303]) db.prepare('INSERT INTO users (id,name,language) VALUES (?,?,?)').run(id,`User ${id}`,'en');
const insert = db.prepare('INSERT INTO user_chats (user_id,title,updated_at,retention,room_enabled) VALUES (?,?,?,?,1)');
const ids: number[]=[];
for(let i=0;i<125;i++) ids.push(Number(insert.run(101,`Chat ${i}`,'2026-10-29 18:00:00','persistent').lastInsertRowid));
insert.run(101,'Temporary','2026-10-29 18:00:00','temporary');
insert.run(303,'Private','2026-10-29 18:00:00','persistent');
assert.deepEqual(getUnfiledActivityCounts(101,{},'Asia/Tomsk'),{'2026-10-30':125},'all pages, no temporary or foreign chats');
assert.equal(listUserChats(101,25).length,25);
const folder=createChatFolder(101,'Folder');
moveUserChatToFolder(101,ids[0],folder.id);
assert.deepEqual(getUnfiledActivityCounts(101,{},'Asia/Tomsk'),{'2026-10-30':124},'exclude folder placement');
db.prepare('INSERT INTO chat_members (chat_id,user_id) VALUES (?,?)').run(ids[0],202);
assert.deepEqual(getUnfiledActivityCounts(202,{},'Asia/Tomsk'),{'2026-10-30':1},'member placement independent of owner folder');
const memberFolder=createChatFolder(202,'Member folder');
moveUserChatToFolder(202,ids[0],memberFolder.id);
assert.deepEqual(getUnfiledActivityCounts(202,{},'Asia/Tomsk'),{});
db.prepare("INSERT INTO chat_messages (chat_id,user_id,role,content,model_name) VALUES (?,?,'assistant','hello','test-model')").run(ids[1],101);
assert.deepEqual(getUnfiledActivityCounts(101,{modelName:'test-model'},'UTC'),{'2026-10-29':1},'same model filters as list');
assert.deepEqual(getUnfiledActivityCounts(101,{hasImages:true},'UTC'),{});
assert.deepEqual(getUnfiledActivityCounts(101,{hasFiles:true},'UTC'),{});
db.close();
console.log('chat-activity-counts integration tests passed');
