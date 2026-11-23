// Run with Electron after npm run build. The parent API is a fixture, not a live user account.
const assert = require('node:assert/strict');
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
protocol.registerSchemesAsPrivileged([{ scheme: INTERACTIVE_SCHEME, privileges: { standard: true, secure: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-library-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const start=Date.now();while(!await check()){if(Date.now()-start>15000)throw new Error('Library fixture timed out');await sleep(30);} }
let host, manager;
let step = 'starting';
const deadline = setTimeout(()=>{console.error('Library fixture deadline:',step);app.exit(1);},30000);
app.whenReady().then(async()=>{
  host=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await host.loadURL('data:text/html,<body>Host</body>');manager=new InteractivePreviews();
  const actions=[];
  let state={activeChatId:99,view:'home',messages:[],confirmations:[],sections:[],chats:[
    {id:1,title:'Original',folderId:null,isOwner:true,botHidden:false,actions:['rename','downloadDocx','move','setBotHidden','delete']},
    {id:2,title:'Joined room',folderId:10,isOwner:false,botHidden:false,actions:['rename','downloadDocx','move','setBotHidden','leave']},
  ],folders:[{id:10,name:'Folder',count:1,actions:['rename','delete']}],
    library:{busy:false,operation:null,error:null,canCreateFolder:true,limits:{chatTitle:120,folderName:80}},
    labels:{renameChat:'Переименовать',downloadDocx:'DOCX',moveChat:'Переместить',hideFromBot:'Скрыть',showInBot:'Показать',delete:'Удалить',leaveChat:'Покинуть',renameFolder:'Переименовать папку',deleteFolder:'Удалить папку'}};
  const id=manager.create(host.webContents,{language:'tsx',source:'',dark:true,errorLabel:'Library failed',bridge:'appearance-chat-list-v1',project:{entry:'App.tsx',files:{'App.tsx':`
import React from 'react';import {useChatterState} from '@chatter/ui';
export default function App(){const state=useChatterState({navigation:true}),[target,setTarget]=React.useState(null),[name,setName]=React.useState('');if(!state)return <p>Loading</p>;
return <main>{state.chats.map(chat=><section key={chat.id} data-chat={chat.id}><h2>{chat.title}</h2>{window.chatter.getChatMenu(chat.id).map(item=><button key={item.id} data-action={item.id} disabled={item.disabled} onClick={()=>{
if(item.id==='rename'){setTarget({kind:'rename',id:chat.id});setName(chat.title)}
else if(item.id==='setBotHidden')window.chatter.setChatBotHidden(chat.id,!chat.botHidden);
else if(item.id==='move')window.chatter.moveChat(chat.id,10);
else if(item.id==='downloadDocx')window.chatter.downloadChatDocx(chat.id);
else setTarget({kind:item.id,id:chat.id});}}>{item.label}</button>)}</section>)}
<input id="folder-name" value={name} onChange={event=>setName(event.target.value)}/><button id="create-folder" disabled={state.library.busy} onClick={()=>window.chatter.createFolder(name)}>Create</button>
{state.folders.map(folder=><section data-folder={folder.id} key={folder.id}><h3>{folder.name}</h3>{window.chatter.getFolderMenu(folder.id).map(item=><button key={item.id} data-action={item.id} disabled={item.disabled} onClick={()=>{setTarget({kind:item.id==='rename'?'renameFolder':'deleteFolder',id:folder.id});setName(folder.name)}}>{item.label}</button>)}</section>)}
{target&&<aside id="own-dialog" role="dialog" aria-modal="true"><input id="name" value={name} onChange={event=>setName(event.target.value)}/><button id="confirm" onClick={()=>{
if(target.kind==='rename')window.chatter.renameChat(target.id,name);else if(target.kind==='renameFolder')window.chatter.renameFolder(target.id,name);else if(target.kind==='deleteFolder')window.chatter.deleteFolder(target.id,true);else if(target.kind==='leave')window.chatter.leaveChat(target.id,true);else window.chatter.deleteChat(target.id,true);setTarget(null)}}>Confirm</button><button id="cancel" onClick={()=>setTarget(null)}>Cancel</button></aside>}
<p id="error">{state.library.error}</p></main>}`}}});
  const contents=host.contentView.children.at(-1).children[0].webContents;
  contents.on('console-message',(_event,_level,message)=>{if(!message.includes('Electron Security Warning'))console.log('theme:',message);});
  const send=host.webContents.send.bind(host.webContents);
  host.webContents.send=(channel,payload)=>{
    if(channel==='interactive-preview:appearance-action'){
      const action=payload.action;actions.push(action);
      if(action.type==='chatMenuAction'){
        if(action.action==='rename')state={...state,chats:state.chats.map(chat=>chat.id===action.id?{...chat,title:action.title}:chat)};
        if(action.action==='move')state={...state,chats:state.chats.map(chat=>chat.id===action.id?{...chat,folderId:action.folderId}:chat)};
        if(action.action==='setBotHidden')state={...state,chats:state.chats.map(chat=>chat.id===action.id?{...chat,botHidden:action.hidden}:chat)};
        if(action.action==='delete'||action.action==='leave')state={...state,chats:state.chats.filter(chat=>chat.id!==action.id)};
      }else if(action.type==='folderMenuAction'){
        if(action.action==='create')state={...state,folders:[...state.folders,{id:11,name:action.name,count:0,actions:['rename','delete']}]};
        if(action.action==='rename')state={...state,folders:state.folders.map(folder=>folder.id===action.id?{...folder,name:action.name}:folder)};
        if(action.action==='delete')state={...state,folders:state.folders.filter(folder=>folder.id!==action.id),chats:state.chats.map(chat=>chat.folderId===action.id?{...chat,folderId:null}:chat)};
      }
      manager.updateAppearanceState(host.webContents,id,state);
    }return send(channel,payload);
  };
  manager.updateAppearanceState(host.webContents,id,state);
  const js=source=>{step=source;return contents.executeJavaScript(source);}, click=selector=>{step='click '+selector;return contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`,true);};
  const type=(selector,value)=>contents.executeJavaScript(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,true);
  await until(async()=>await js('document.querySelector("[data-chat] h2")?.textContent')==='Original');
  assert.equal(await js('window.chatter.renameChat(1,"No gesture")'),false);
  assert.equal(await contents.executeJavaScript('window.chatter.deleteChat(1)',true),false);
  await click('[data-chat="1"] [data-action="rename"]');await until(async()=>await js('!!document.querySelector("#own-dialog")'));
  assert.equal(actions.length,0,'opening a custom rename form performs no native action');
  await type('#name','Renamed in theme');await click('#confirm');
  await until(async()=>await js('document.querySelector("[data-chat] h2")?.textContent')==='Renamed in theme');
  assert.equal(actions.at(-1).id,1,'a non-active chat is a valid menu target');
  await click('[data-chat="1"] [data-action="setBotHidden"]');
  await until(async()=>await js('document.querySelector("[data-chat=\\"1\\"] [data-action=\\"setBotHidden\\"]")?.textContent')==='Показать');
  await click('[data-chat="1"] [data-action="move"]');await until(()=>state.chats[0].folderId===10);
  await type('#folder-name','Created in theme');await click('#create-folder');await until(()=>state.folders.length===2);
  await click('[data-folder="11"] [data-action="rename"]');await type('#name','Renamed folder');await click('#confirm');await until(()=>state.folders[1].name==='Renamed folder');
  const beforeCancel=actions.length;
  await click('[data-chat="1"] [data-action="delete"]');await click('#cancel');assert.equal(actions.length,beforeCancel);
  await click('[data-folder="10"] [data-action="delete"]');await click('#confirm');await until(()=>!state.folders.some(folder=>folder.id===10));
  assert.equal(state.chats.length,2,'folder deletion does not delete chats');assert.equal(state.chats[0].folderId,null);
  assert.equal(await js('!!document.querySelector("[data-chat=\\"2\\"] [data-action=\\"delete\\"]")'),false);
  await click('[data-chat="2"] [data-action="leave"]');await click('#confirm');await until(()=>state.chats.length===1);
  assert.equal(actions.at(-1).action,'leave');assert.equal(actions.at(-1).confirmed,true);
  state={...state,library:{...state.library,busy:true}};manager.updateAppearanceState(host.webContents,id,state);
  await until(async()=>await js('document.querySelector("[data-chat] button")?.disabled')===true);
  assert.equal(await contents.executeJavaScript('window.chatter.renameChat(1,"Busy")',true),false);
  assert.equal(actions.some(action=>['openLibrary','openConversation','openSettings'].includes(action.type)),false);
  assert.equal(await js('[typeof electronAPI,typeof require].join(",")'),'undefined,undefined');
  console.log('PASS: theme-authored chat/folder menus and forms, scoped non-active targets, localized toggles, custom confirmations/cancel, folder preservation, leave vs delete, busy/gesture checks and no native navigation');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);manager?.destroy();host?.destroy();app.exit(process.exitCode??0);});
