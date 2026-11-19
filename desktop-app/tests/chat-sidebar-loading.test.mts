import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import type { ChatFolderList, ChatInfo } from '../src/renderer/lib/api.ts';
const require = createRequire(import.meta.url);
const { loadChatSidebar } = require('../src/renderer/lib/chat-sidebar-service.ts');
const ts = require('../node_modules/typescript');
const chat = (id: number, folderId: number | null): ChatInfo => ({id,title:'New '+id,folder_id:folderId,created_at:1});
const rows = new Map<number | null, ChatInfo[]>([
  [1,Array.from({length:120},(_, n)=>chat(1000+n,1))],
  [2,Array.from({length:7},(_, n)=>chat(2000+n,2))],
  [null,Array.from({length:215},(_, n)=>chat(3000+n,null))],
]);
const folder = (id: number, amount: number) => ({id,name:'Folder '+id,sort_order:id,created_at:1,updated_at:1,chat_count:amount});
const metadata = (previews=true): ChatFolderList => ({
  folders:[folder(1,120),folder(2,7),folder(3,0)],unfiled_count:215,total_count:342,
  active_chat_id:1110,active_chat:chat(1110,1),unfiled_activity_days:{'2026-11-19':215},
  ...(previews ? {chat_previews:[...rows.values()].flatMap(items=>items.slice(0,25))} : {}),
});
let calls: Array<{limit:number;offset:number;filters:any}> = [];
const source = {
  getChatFolders:async (_filters:any,limit:number) => {assert.equal(limit,25);return metadata();},
  getChats:async (limit:number,offset:number,filters:any) => {
    calls.push({limit,offset,filters});
    const list = rows.get(filters.folderId) ?? [];
    return {chats:list.slice(offset,offset+limit),total:list.length,active_chat_id:1110};
  },
};
const first = await loadChatSidebar(source,{});
assert.ok(first);
assert.equal(calls.length,0,'closed folders must be ready from the bootstrap response without per-folder requests');
assert.deepEqual(first.paging['folder:1'],{offset:25,total:120,hasMore:true,loading:false});
assert.deepEqual(first.paging['folder:2'],{offset:7,total:7,hasMore:false,loading:false});
assert.deepEqual(first.paging['folder:3'],{offset:0,total:0,hasMore:false,loading:false});
assert.equal(first.chats.filter((item:ChatInfo)=>item.folder_id===2).length,7);
assert.ok(first.chats.some((item:ChatInfo)=>item.id===1110),'selected chat outside a prefix must remain visible');
assert.equal(first.paging['folder:1'].offset,25,'an extra selected chat must not skip pagination items');
calls = [];
const deep = await loadChatSidebar(source,{},{
  'folder:1':{offset:75,total:120,hasMore:true,loading:false},
  unfiled:{offset:200,total:215,hasMore:true,loading:false},
});
assert.equal(deep.paging['folder:1'].offset,75);
assert.equal(deep.paging.unfiled.offset,200);
assert.equal(deep.chats.filter((item:ChatInfo)=>item.folder_id===null).length,200);
assert.ok(calls.every(call=>call.limit<=100),'deep refreshes must respect the existing server page cap');
assert.deepEqual(calls.filter(call=>call.filters.folderId===1).map(call=>[call.limit,call.offset]),[[50,25]]);
assert.deepEqual(calls.filter(call=>call.filters.folderId===null).map(call=>[call.limit,call.offset]),[[100,25],[75,125]]);
const filtered = await loadChatSidebar(source,{model:'a-model'});
assert.ok(!filtered.chats.some((item:ChatInfo)=>item.id===1110),'selected chats must not leak through active filters');

// Older servers have no batch previews; reuse ordinary section pages with bounded concurrency.
let concurrent=0,peak=0,legacyCalls=0;
const legacy = {
  getChatFolders:async ()=>({ ...metadata(false),folders:Array.from({length:16},(_,n)=>folder(n+1,2)),unfiled_count:0 }),
  getChats:async (_limit:number,_offset:number,filters:any)=>{
    legacyCalls++;concurrent++;peak=Math.max(peak,concurrent);
    await new Promise(resolve=>setTimeout(resolve,2));concurrent--;
    return {chats:[chat(filters.folderId*100,filters.folderId),chat(filters.folderId*100+1,filters.folderId)],total:2,active_chat_id:null};
  },
};
const compatible = await loadChatSidebar(legacy,{});
assert.equal(legacyCalls,16);
assert.ok(peak>1 && peak<=4,'compatibility requests must not stampede all folders');
assert.equal(compatible.paging['folder:16'].offset,2);
let current=false;
legacyCalls=0;
assert.equal(await loadChatSidebar(legacy,{}, {},()=>current),null);
assert.equal(legacyCalls,0,'a superseded bootstrap must not start folder requests');
current=true;
const stale = { ...legacy,getChats:async (...args:any[])=>{current=false;return legacy.getChats(...args as [number,number,any]);} };
assert.equal(await loadChatSidebar(stale,{}, {},()=>current),null);
assert.ok(legacyCalls<=4,'a superseded filter/account must stop remaining queued work');

// Run the actual page callback, including atomic refresh, errors and selection races.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx',import.meta.url),'utf8');
const ast = ts.createSourceFile('ChatPage.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler='';
function visit(node:any) {
  if(ts.isVariableDeclaration(node) && node.name.getText(ast)==='loadChats') handler=node.initializer.getText(ast);
  ts.forEachChild(node,visit);
}
visit(ast);assert.ok(handler);
const code=ts.transpileModule('globalThis.reload = '+handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
let state:any={chats:rows.get(1)!.slice(0,75),folders:metadata().folders,unfiled:215,activity:{old:1},loading:false,selected:777};
let resolveMetadata:(value:ChatFolderList)=>void = ()=>{};
let rejectMetadata:(error:Error)=>void = ()=>{};
let sourceMetadata=()=>new Promise<ChatFolderList>((resolve,reject)=>{resolveMetadata=resolve;rejectMetadata=reject;});
let filters:any={};
const apply=(key:string)=>(value:any)=>{state[key]=typeof value==='function'?value(state[key]):value;};
const paging={current:{'folder:1':{offset:75,total:120,hasMore:true,loading:false}}};
const context:any={
  loadChatSidebar,api:{...source,API_BASE:'server-a',getChatFolders:()=>sourceMetadata(),getChatFilterOptions:async()=>({prompts:[],models:[]})},
  user:{id:1},useCallback:(fn:any)=>fn,getCurrentChatFilters:()=>filters,
  chatListGenerationRef:{current:0},chatSelectionVersionRef:{current:0},
  chatListScopeRef:{current:JSON.stringify(['server-a',1,{}])},sectionPagingRef:paging,
  activityRevisionRef:{current:0},pendingActivityRef:{current:new Map()},
  setChats:apply('chats'),setChatFolders:apply('folders'),setUnfiledChatCount:apply('unfiled'),
  setActivityDays:apply('activity'),setLoadingChats:apply('loading'),setActiveChatId:apply('selected'),
  setChatFilterOptions:apply('options'),updateSectionPaging:(value:any)=>{paging.current=value;},
  console:{error:()=>{}},
};
vm.createContext(context);vm.runInContext(code,context);
const previousRows=state.chats;
const inFlight=context.reload();
assert.equal(state.chats,previousRows,'a background refresh must keep already loaded rows on screen');
assert.equal(paging.current['folder:1'].offset,75,'a refresh must not reset folder cursors to zero');
assert.equal(paging.current['folder:1'].loading,true,'section paging must pause during an atomic prefix refresh');
context.chatSelectionVersionRef.current++;
resolveMetadata(metadata());
await inFlight;
assert.equal(state.chats.filter((item:ChatInfo)=>item.folder_id===1 && item.id!==1110).length,75);
assert.equal(paging.current['folder:1'].offset,75);
assert.equal(state.selected,777,'a delayed refresh must not undo a newer user selection');
const successfulRows=state.chats;
const failed=context.reload();
rejectMetadata(new Error('offline'));
await failed;
assert.equal(state.chats,successfulRows,'a failed refresh must not clear loaded folders');
assert.equal(state.loading,false);

// Only the newest request may apply; old responses must not empty a newer list.
const earlier=context.reload();
const resolveEarlier=resolveMetadata;
sourceMetadata=async()=>metadata();
await context.reload();
const newestRows=state.chats;
resolveEarlier({...metadata(),chat_previews:[]});
await earlier;
assert.equal(state.chats,newestRows);
filters={model:'model-b'};
calls=[];
await context.reload();
assert.equal(paging.current['folder:1'].offset,25,'pagination depth must not cross filter scopes');
assert.equal(calls.length,0);
console.log('PASS: closed-folder bootstrap, refreshed loaded prefixes, correct cursors, active-chat handling, legacy compatibility, bounded concurrency, stale requests, atomic page refresh, failed refresh and filter isolation');
