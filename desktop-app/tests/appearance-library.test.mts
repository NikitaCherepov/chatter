import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const { parseAppearanceShellAction: parse, canRunAppearanceAction: allowed } = require('../src/main/appearance-shell-types.ts');
const ownerActions = ['rename','downloadDocx','move','setBotHidden','delete'];
const memberActions = ['rename','downloadDocx','move','setBotHidden','leave'];
const state = { activeChatId: 99, chats: [{ id: 1, title: 'Owner', isOwner: true, botHidden: false, actions: ownerActions },
  { id: 2, title: 'Room', isOwner: false, actions: memberActions }, { id: 3, title: 'Search summary', isOwner: null, actions: [] }],
  folders: [{ id: 10, name: 'Folder', count: 1, actions: ['rename','delete'] }],
  library: { busy: false, canCreateFolder: true }, messages: [], labels: { renameChat: 'Переименовать', hideFromBot: 'Скрыть', showInBot: 'Показать', deleteFolder: 'Удалить папку' } };
for (const request of [
  { type:'chatMenuAction',id:1,action:'rename',title:'Renamed' },
  { type:'chatMenuAction',id:1,action:'move',folderId:null },
  { type:'chatMenuAction',id:1,action:'move',folderId:10 },
  { type:'chatMenuAction',id:1,action:'delete',confirmed:true },
  { type:'chatMenuAction',id:2,action:'leave',confirmed:true },
  { type:'folderMenuAction',id:null,action:'create',name:'New' },
  { type:'folderMenuAction',id:10,action:'rename',name:'Renamed folder' },
  { type:'folderMenuAction',id:10,action:'delete',confirmed:true },
]) assert.equal(allowed(state, parse(request)), true, JSON.stringify(request));
for (const change of [
  {type:'chatMenuAction',id:0,action:'rename',title:'x'}, {type:'chatMenuAction',id:1,action:'rename',title:' '},
  {type:'chatMenuAction',id:1,action:'rename',title:'x'.repeat(121)}, {type:'chatMenuAction',id:1,action:'delete'},
  {type:'chatMenuAction',id:1,action:'delete',confirmed:'true'}, {type:'chatMenuAction',id:1,action:'move',folderId:-1},
  {type:'chatMenuAction',id:1,action:'setBotHidden',hidden:1}, {type:'folderMenuAction',id:10,action:'create',name:'x'},
  {type:'folderMenuAction',id:null,action:'rename',name:'x'}, {type:'folderMenuAction',id:10,action:'delete'},
  {type:'folderMenuAction',id:null,action:'create',name:'x'.repeat(81)},
]) assert.equal(parse(change), null, JSON.stringify(change));
for (const change of [
  {type:'chatMenuAction',id:2,action:'delete',confirmed:true}, {type:'chatMenuAction',id:1,action:'leave',confirmed:true},
  {type:'chatMenuAction',id:3,action:'rename',title:'x'}, {type:'chatMenuAction',id:404,action:'downloadDocx'},
  {type:'chatMenuAction',id:1,action:'move',folderId:404}, {type:'folderMenuAction',id:404,action:'delete',confirmed:true},
]) assert.equal(allowed(state, parse(change)), false, JSON.stringify(change));
assert.equal(allowed({ ...state, library: { ...state.library, busy: true } }, parse({type:'chatMenuAction',id:1,action:'downloadDocx'})), false);

let api: any, activated = false;
const events = new Map(), sent: any[] = [];
const preload = fs.readFileSync(new URL('../src/main/appearance-shell-preload.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(preload, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: {}, URL, URLSearchParams, setTimeout, clearTimeout, location: { href: 'chatter-interactive://test/index.html' },
  require: () => ({ contextBridge: { exposeInMainWorld: (_: any, value: any) => { api = value; } },
    ipcRenderer: { on: (name: string, fn: any) => events.set(name, fn), send: (...args: any[]) => sent.push(args) } }),
  navigator: { userActivation: { get isActive() { return activated; } } }, window: { addEventListener() {} }, console,
});
events.get('appearance-shell:state')({}, state);
assert.equal(api.getChatMenu(1).find((item: any)=>item.id==='rename').label, 'Переименовать');
assert.equal(api.getChatMenu(1).find((item: any)=>item.id==='setBotHidden').label, 'Скрыть');
assert.equal(api.getChatMenu(1).find((item: any)=>item.id==='delete').requiresConfirmation, true);
assert.equal(api.getChatMenu(2).some((item: any)=>item.id==='delete'), false);
assert.equal(api.getChatMenu(3).length, 0);
assert.equal(api.renameChat(1,'New'), false);
assert.equal(api.createFolder('New'), false);
activated = true;
assert.equal(api.renameChat(1,' New '), true);
assert.equal(sent.at(-1)[1].title, 'New');
assert.equal(api.moveChat(1,404), false);
assert.equal(api.moveChat(1,null), true);
assert.equal(api.deleteChat(1), false); assert.equal(api.deleteChat(1,false), false);
assert.equal(api.deleteChat(1,true), true); assert.equal(api.deleteChat(2,true), false);
assert.equal(api.leaveChat(2,true), true); assert.equal(api.leaveChat(1,true), false);
assert.equal(api.deleteFolder(10,false), false); assert.equal(api.deleteFolder(10,true), true);
events.get('appearance-shell:state')({}, { ...state, chats:[{...state.chats[0],botHidden:true}], library:{...state.library,busy:true} });
assert.equal(api.getChatMenu(1).find((item: any)=>item.id==='setBotHidden').label, 'Показать');
assert.equal(api.getChatMenu(1).every((item: any)=>item.disabled), true);
assert.equal(api.createFolder('New'), false);
console.log('PASS: menu descriptors, localized dynamic labels, genuine gestures, explicit destructive confirmation, role/destination/stale-ID and busy validation for non-active chats');

// Exercise the shared native/sidebar handlers and the real host dispatcher against a fixture API.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8');
const between = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));
const declarations = [
  between('  const runLibraryMutation =', '  const updateSectionPaging ='),
  between('  const renameSidebarChat =', '  const handleConfirmRename ='),
  between('  const removeSidebarChat =', '  const handleLeaveRoomFromSidebar ='),
  between('  const setSidebarBotHidden =', '  const handleToggleBotHidden ='),
  between('  const handleExportChat =', '  const startMsgMenuTimer ='),
  between('  const createSidebarFolder =', '  const finishDemoFolderRename ='),
  between('  const deleteDemoFolder =', '  const handleDemoChatDragStart ='),
  between('  const handleShellAction =', '  const shellVisible ='),
].join('\n');
const calls: any[] = [], errors: any[] = [], statuses: any[] = [];
let rejectMethod = '', gate: Promise<void> | null = null;
const c: any = { canRunAppearanceAction: allowed, shellState: state, appearanceShell:{scope:'workspace'},
  libraryScopeRef:{current:'account-A'},libraryMountedRef:{current:true},libraryEpochRef:{current:1},libraryPending:{current:null},libraryReadyRef:{current:true},
  libraryReloadRef:{current:async()=>{calls.push(['reloadCurrent']);}},
  t:(key:string)=>key, toast:{error:(message:any)=>errors.push(message),success:()=>{}}, console,
  chats:[{id:1,title:'Owner',folder_id:null,is_owner:true,bot_hidden:false},{id:2,title:'Room',folder_id:10,is_owner:false}],
  chatFolders:[{id:10,name:'Folder',chat_count:1}],searchResults:[{chat_id:1,chat_title:'Owner',folder_id:null}],
  activeChatIdRef:{current:1}, messages:[], shellView:'conversation', unfiledChatCount:1,
  sectionPagingRef:{current:{unfiled:{offset:1,total:1,hasMore:false,loading:false},'folder:10':{offset:1,total:1,hasMore:false,loading:false}}},
  demoRenamingFolderId:null,
  setLibraryStatus:(value:any)=>{statuses.push(value);c.status=value;},
  setChats:(fn:any)=>{c.chats=typeof fn==='function'?fn(c.chats):fn;},setChatFolders:(fn:any)=>{c.chatFolders=typeof fn==='function'?fn(c.chatFolders):fn;},
  setSearchResults:(fn:any)=>{c.searchResults=typeof fn==='function'?fn(c.searchResults):fn;},setUnfiledChatCount:(fn:any)=>{c.unfiledChatCount=typeof fn==='function'?fn(c.unfiledChatCount):fn;},
  setActiveChatId:(id:any)=>{c.activeChatIdRef.current=id;}, setMessages:(value:any)=>{c.messages=value;},setShellView:(value:any)=>{c.shellView=value;},
  workspace:{removeTab:(id:any)=>calls.push(['removeTab',id])},
  updateSectionPaging:(value:any)=>{c.sectionPagingRef.current=value;},
  refreshChatListMetadata:async()=>{calls.push(['refresh']);},loadChats:async()=>{calls.push(['loadChats']);},
  setContextMenuChatId:()=>{},setDemoMoveMenuOpen:()=>{},setDemoExpandedFolders:()=>{},setDemoFolderMenuId:()=>{},setDemoRenamingFolderId:()=>{},
  generateChatDocxBlob:async()=>new Blob(['docx']),window:{electronAPI:{saveFile:async(name:string)=>{calls.push(['saveFile',name]);return{canceled:false};}}},
  setShellOpen:()=>{throw new Error('Menus must stay inside the custom shell');},
};
const method = (name:string, result:any={ok:true}) => async(...args:any[])=>{calls.push([name,...args]);if(gate)await gate;if(rejectMethod===name)throw new Error('fixture failure');return result;};
c.api={renameChat:method('renameChat'),deleteChat:method('deleteChat'),leaveRoom:method('leaveRoom'),setChatBotHidden:method('setChatBotHidden'),
  createChatFolder:method('createChatFolder',{folder:{id:11,name:'Created',chat_count:0}}),renameChatFolder:method('renameChatFolder'),deleteChatFolder:method('deleteChatFolder'),
  moveChatToFolder:method('moveChatToFolder'),getMessages:method('getMessages',{messages:[{content:'hello'}]})};
vm.createContext(c);
vm.runInContext(ts.transpileModule(declarations+'\nglobalThis.operations={renameSidebarChat,removeSidebarChat,setSidebarBotHidden,handleExportChat,createSidebarFolder,renameSidebarFolder,deleteDemoFolder,moveDemoChat,handleShellAction};',
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
const op=c.operations;
c.libraryReadyRef.current=false;
assert.equal(await op.renameSidebarChat(1,'Not loaded'),false);assert.equal(calls.length,0);
c.libraryReadyRef.current=true;
assert.equal(await op.renameSidebarChat(1,'Updated'),true);
assert.equal(c.chats[0].title,'Updated'); assert.equal(c.searchResults[0].chat_title,'Updated');
assert.equal(await op.moveDemoChat(1,10),true);
assert.equal(c.chats[0].folder_id,10);assert.equal(c.chatFolders[0].chat_count,2);assert.equal(c.unfiledChatCount,0);
assert.equal(c.sectionPagingRef.current.unfiled.total,0);
rejectMethod='moveChatToFolder';
assert.equal(await op.moveDemoChat(1,null),false);
assert.equal(c.chats[0].folder_id,10);assert.equal(c.chatFolders[0].chat_count,2);assert.equal(c.unfiledChatCount,0);
assert.ok(c.status.error); rejectMethod='setChatBotHidden';
assert.equal(await op.setSidebarBotHidden(1,true),false);assert.equal(c.chats[0].bot_hidden,false);
rejectMethod=''; await op.setSidebarBotHidden(1,true); assert.equal(c.chats[0].bot_hidden,true);
await op.createSidebarFolder('Created');assert.equal(c.chatFolders.at(-1).id,11);
rejectMethod='renameChatFolder';await op.renameSidebarFolder(11,'Failed');assert.equal(c.chatFolders.at(-1).name,'Created');
rejectMethod='';await op.renameSidebarFolder(11,'Renamed');assert.equal(c.chatFolders.at(-1).name,'Renamed');
rejectMethod='deleteChatFolder';await op.deleteDemoFolder(10);
assert.equal(c.chats.every((chat:any)=>chat.folder_id===10),true);
assert.equal(c.chatFolders[0].chat_count,2);assert.equal(c.unfiledChatCount,0);
rejectMethod='';
await op.deleteDemoFolder(10);
assert.equal(c.chatFolders.some((folder:any)=>folder.id===10),false);
assert.equal(c.chats.length,2);assert.equal(c.chats.every((chat:any)=>chat.folder_id===null),true);
assert.equal(c.unfiledChatCount,2);
await op.handleExportChat(1); assert.ok(calls.some(call=>call[0]==='saveFile'&&call[1].endsWith('.docx')));
// Duplicate requests are rejected before the first network request settles.
let release!:()=>void; gate=new Promise(resolve=>{release=resolve;});
const pending=op.renameSidebarChat(1,'Pending');
assert.equal(await op.createSidebarFolder('Duplicate'),false);
assert.equal(c.status.busy,true);release();gate=null;await pending;assert.equal(c.status.busy,false);
// Returning to the same textual scope must not revive an obsolete request.
gate=new Promise(resolve=>{release=resolve;});const stale=op.renameSidebarChat(1,'Stale');
c.libraryEpochRef.current+=2;
release();gate=null;assert.equal(await stale,false);
assert.equal(c.chats[0].title,'Pending');assert.equal(c.status.operation,null);
assert.ok(calls.some(call=>call[0]==='reloadCurrent'));
await op.removeSidebarChat(2,true);assert.ok(calls.some(call=>call[0]==='leaveRoom'&&call[1]===2));
assert.equal(c.chats.some((chat:any)=>chat.id===2),false);
await op.removeSidebarChat(1,false);assert.equal(c.activeChatIdRef.current,null);assert.equal(c.shellView,'home');
assert.equal(c.chats.length,0);assert.equal(c.unfiledChatCount,0);
// Dispatcher routes to the same shared handlers and does not request native menus.
c.chats=[{id:1,title:'Owner',is_owner:true,folder_id:null}]; c.shellState=state;
op.handleShellAction(parse({type:'chatMenuAction',id:1,action:'rename',title:'From shell'}));
await new Promise(resolve=>setImmediate(resolve));assert.equal(c.chats[0].title,'From shell');
gate=new Promise(resolve=>{release=resolve;});const unmounted=op.renameSidebarChat(1,'After unmount');
const statusCount=statuses.length;c.libraryMountedRef.current=false;
release();gate=null;assert.equal(await unmounted,false);
assert.equal(c.chats[0].title,'From shell');assert.equal(statuses.length,statusCount,'unmounted components get no completion state writes');
console.log('PASS: real shared handlers and dispatcher, search updates, folder/paging counts, move/visibility/rename rollback, DOCX path, serialized mutations, obsolete-scope suppression, delete vs leave and no native shell navigation');
