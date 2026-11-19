import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-folder-previews-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.ENCRYPTION_KEY = 'folder-preview-test-key';
const { db } = await import('../src/db.js');
const { listUserChats, listUserChatPreviews, listChatFolders, createChatFolder, moveUserChatToFolder, ensureActiveChat, getUserChatListItem, getUnfiledActivityCounts } =
  await import('../src/services/chats.js');

try {
  for (const id of [101, 202, 303]) db.prepare('INSERT INTO users (id,name,language) VALUES (?,?,?)').run(id, String(id), 'en');
  const a = createChatFolder(101, 'A');
  const b = createChatFolder(101, 'B');
  const empty = createChatFolder(101, 'Closed and empty');
  const foreignFolder = createChatFolder(202, 'Foreign owner folder');
  const insert = db.prepare("INSERT INTO user_chats (user_id,title,folder_id,updated_at) VALUES (?,?,?,'2026-11-19 12:00:00')");
  const ids: number[] = [];
  for (const [folderId, amount] of [[a.id, 140], [b.id, 43], [null, 12]] as const) {
    for (let index = 0; index < amount; index++) ids.push(Number(insert.run(101, `Chat ${folderId}-${index}`, folderId).lastInsertRowid));
  }
  const privateId = Number(insert.run(202, 'Private foreign chat', foreignFolder.id).lastInsertRowid);
  const sharedId = Number(insert.run(202, 'Shared owner title', foreignFolder.id).lastInsertRowid);
  db.prepare('UPDATE user_chats SET room_enabled = 1 WHERE id = ?').run(sharedId);
  db.prepare('INSERT INTO chat_members (chat_id,user_id,title,folder_id) VALUES (?,?,?,?)').run(sharedId,101,'Personal room title',b.id);
  const temporaryId = Number(insert.run(101, 'Hidden temporary chat', a.id).lastInsertRowid);
  db.prepare("UPDATE user_chats SET retention = 'temporary' WHERE id = ?").run(temporaryId);
  db.prepare('UPDATE users SET active_chat_id = ? WHERE id = ?').run(ids[0],101);
  db.prepare("INSERT INTO prompts (id,name,content) VALUES (77,'Filter prompt','')").run();
  // The same message-based filters must apply to previews and ordinary pages.
  const message = db.prepare('INSERT INTO chat_messages (user_id,chat_id,role,content,prompt_id,model_name,attachments,images) VALUES (?,?,?,?,?,?,?,?)');
  for (const id of ids.filter((_, index) => index % 2 === 0)) {
    message.run(101,id,'user','Filter match',77,'model-test','[{\"name\":\"report.txt\"}]','[{\"url\":\"image.png\"}]');
  }
  for (const filters of [{}, {promptId:77}, {modelName:'model-test'}, {hasFiles:true}, {hasImages:true}, {folderId:b.id}]) {
    const preview = listUserChatPreviews(101,25,filters);
    for (const folderId of [a.id,b.id,null]) {
      assert.deepEqual(preview.filter(chat => chat.folder_id === folderId), listUserChats(101,25,0,{...filters,folderId})
        .filter(() => filters.folderId === undefined || filters.folderId === folderId),
      'previews must match the existing pagination, ordering, DTOs, filters and per-user placement');
    }
    assert.ok(!preview.some(chat => chat.id === privateId || chat.id === temporaryId));
  }
  const rooms = listUserChatPreviews(101,100).filter(chat => chat.id === sharedId);
  assert.equal(rooms[0]?.title,'Personal room title');
  assert.equal(rooms[0]?.folder_id,b.id);
  assert.equal(rooms[0]?.is_owner,false);
  assert.equal(listChatFolders(101).folders.find(folder => folder.id === empty.id)?.chat_count,0);
  assert.equal(listUserChatPreviews(101,999).filter(chat => chat.folder_id === a.id).length,100,'preview limits must stay bounded');
  assert.equal(listUserChatPreviews(101,1).filter(chat => chat.folder_id === a.id).length,1);
  assert.equal(moveUserChatToFolder(101,sharedId,null),true);
  assert.equal(listUserChatPreviews(101,25).find(chat => chat.id === sharedId)?.folder_id,null);
  assert.ok(!listUserChatPreviews(303,25).some(chat => ids.includes(chat.id) || chat.id === sharedId || chat.id === privateId));
  // Execute the actual HTTP handler with real services, without starting a live server.
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const server = fs.readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  const ast = ts.createSourceFile('server.ts',server,ts.ScriptTarget.Latest,true);
  let handler='';
  function visit(node:any) {
    if(ts.isCallExpression(node) && node.expression.getText(ast)==='app.get'
      && node.arguments[0]?.text==='/api/v1/chat-folders') handler=node.arguments[1].getText(ast);
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.ok(handler);
  const context:any={ensureActiveChat,getUserChatListItem,getUnfiledActivityCounts,listChatFolders,listUserChatPreviews,
    accountIdFromRequest:(request:any)=>request.userId};
  vm.createContext(context);
  vm.runInContext(ts.transpileModule('globalThis.handler = '+handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const request = (query:any,userId=101) => {
    let status=200,body:any;
    context.handler({query,userId},{status(code:number){status=code;return this;},json(data:any){body=data;return this;}});
    return {status,body};
  };
  assert.equal(request({}).status,200);
  assert.equal(request({}).body.chat_previews,undefined,'ordinary metadata requests stay lightweight and backwards compatible');
  const withPreviews=request({preview_limit:'25',time_zone:'Asia/Tomsk'});
  assert.equal(withPreviews.status,200);
  assert.equal(withPreviews.body.chat_previews.filter((chat:any)=>chat.folder_id===a.id).length,25);
  assert.ok(!request({preview_limit:'25'},303).body.chat_previews.some((chat:any)=>ids.includes(chat.id) || chat.id===sharedId));
  for(const preview_limit of ['0','101','NaN','1.5']) {
    const invalid=request({preview_limit});
    assert.equal(invalid.status,400);
    assert.equal(invalid.body.error,'bad_preview_limit');
  }
  console.log('PASS: bounded first pages for all folders, exact existing order, filters, empty folders, temporary chats, per-member titles/placement and access isolation');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('chatter-folder-previews-'));
  fs.rmSync(directory,{recursive:true,force:true});
}
