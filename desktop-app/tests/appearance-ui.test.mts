import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const desktopRoot = path.join(root, 'desktop-app');
const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'));
const { build, transformWithEsbuild } = desktopRequire('vite');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-appearance-ui-'));
const modulePath = (file: string) =>
  JSON.stringify(path.resolve(desktopRoot, 'src/renderer', file).replaceAll('\\', '/'));

const pageSource = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shellOrder = pageSource.match(/\{layout\.chatSide === 'right'\s*\? \[toolsSidebar, conversation, roomSidebar, chatSidebar\]\s*:\s*\[chatSidebar, conversation, roomSidebar, toolsSidebar\]\}/)?.[0];
assert.ok(shellOrder);
const workspaceBar = pageSource.slice(pageSource.indexOf("        {(tabsEnabled || layout.tools === 'toolbar')"), pageSource.indexOf('        {layoutPreview && (', pageSource.indexOf('  const conversation = (')));
assert.ok(workspaceBar.includes('<ChatWorkspaceTabs') && workspaceBar.includes('<ToolsToolbar'));
const workspaceTitle = pageSource.slice(pageSource.indexOf('  const activeChatTitle ='), pageSource.indexOf('  const [libraryOpen,'));
assert.ok(workspaceTitle.includes('workspace.tabs.find'));
const libraryState = pageSource.slice(pageSource.indexOf('  const [libraryOpen,'), pageSource.indexOf('  const [effectivePersonaImageUrl,'));
const libraryFrameStart = pageSource.indexOf('      <motion.aside key="chat-list"');
const libraryFrame = pageSource.slice(libraryFrameStart, pageSource.indexOf('        <div className={s.sidebarHeader}>', libraryFrameStart));
const libraryBackdrop = pageSource.match(/\{tabsEnabled && <div className=\{s\.chatLibraryBackdrop\}[^\n]+\}/)?.[0];
assert.ok(libraryState.includes('chatSidebarRef') && libraryFrame.includes('data-chat-library') && libraryBackdrop);
const shellReturnStart = pageSource.indexOf('  const shellReturnButton =');
const shellReturnButton = pageSource.slice(shellReturnStart, pageSource.indexOf('  const chatSidebar =', shellReturnStart));
const shellNavigationStart = pageSource.indexOf('        {appearanceShell && (', pageSource.indexOf('  const conversation ='));
const shellNavigation = pageSource.slice(shellNavigationStart, pageSource.indexOf("        {(tabsEnabled || layout.tools === 'toolbar')", shellNavigationStart));
assert.ok(shellReturnButton.includes('returnToAppearanceShell') && shellNavigation.includes('shellReturnButton'));
const answerStateStart = pageSource.indexOf('  const workContent = splitWorkContent(displayedVariantContent,');
const answerState = pageSource.slice(answerStateStart, pageSource.indexOf('\n\n  return (', answerStateStart));
const answerBubbleStart = pageSource.indexOf('      <div className={s.bubbleWrap}', answerStateStart);
const answerBubble = pageSource.slice(answerBubbleStart, pageSource.indexOf("      {(msg.role === 'assistant' || msg.role === 'user')", answerBubbleStart));
assert.ok(answerState.includes('hasAnswerBody') && answerBubble.includes('data-answer-bubble'));
const authModule = String.raw`
import React from 'react';
export const TestAuth=React.createContext(null);
export const useAuth=()=>React.useContext(TestAuth);
`;
const apiModule = String.raw`
import { parseAppearanceProfile } from ${modulePath('lib/appearance-schema.ts')};
export const API_BASE='test-server';
export const resolveAuthenticatedAssetUrl=(url)=>url;
const notes=Array.from({length:45},(_,i)=>({id:i+1,title:'Notebook note '+(i+1),content:'Test note text',created_at:1700000000}));
export const listNotes=async()=>({notes,total:notes.length});
export const getNoteById=async(id)=>({note:notes.find(note=>note.id===id)});
export const createNote=async()=>({note_id:46});
export const deleteNote=async()=>({ok:true});
export const apiFetch=async(path,options)=>{
 await new Promise(resolve=>setTimeout(resolve,5));
 if(path==='/api/v1/user/appearance/legacy'||path==='/api/v1/user/appearance'){
  (window.migrationRequests??=[]).push({userId:window.testAccount,path});
  if(window.forceOldThemeServer&&path.endsWith('/legacy'))throw {status:404};
 }
 if(path==='/api/v1/user/appearance'&&options?.method==='POST'){window.serverAppearanceWrites=(window.serverAppearanceWrites??0)+1;throw new Error('Desktop themes must be stored locally');}
 const userId=window.testAccount;
 if(path==='/api/v1/user/chat-layout'){
  const current=window.layoutDb[userId]??{revision:0,activeId:null,profiles:[]};
  if(options?.method!=='POST')return {layout:structuredClone(current)};
  const command=JSON.parse(options.body);
  if(command.action==='save'){
   const profile={...command.profile,revision:command.profile.revision+1};
   current.profiles=[...current.profiles.filter(item=>item.id!==profile.id),profile];
   if(command.apply)current.activeId=profile.id;
  }else if(command.action==='activate')current.activeId=command.id;
  current.revision++;window.layoutDb[userId]=current;
  return {layout:structuredClone(current)};
 }
 const current=window.testDb[userId]??{version:1,revision:0,activeId:null,profiles:[]};
 if(!options)return {appearance:structuredClone(current)};
 if(window.failSave){window.failSave=false;throw {data:{error:'appearance_conflict'}};}
 const command=JSON.parse(options.body);
 if(command.action==='save'){
  const profile=parseAppearanceProfile(command.profile),previous=current.profiles.find(p=>p.id===profile.id);
  profile.revision=(previous?.revision??0)+1;
  current.profiles=previous?current.profiles.map(p=>p.id===profile.id?profile:p):[...current.profiles,profile];
  if(command.apply)current.activeId=profile.id;
 }else if(command.action==='activate')current.activeId=command.id;
 else if(command.action==='delete'){current.profiles=current.profiles.filter(p=>p.id!==command.id);if(current.activeId===command.id)current.activeId=null;}
 current.revision++;window.testDb[userId]=current;
 return {appearance:structuredClone(current)};
};
`;
const fixture = String.raw`
import React,{useState,useRef,useEffect,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createInstance} from 'i18next';
import {I18nextProvider,useTranslation} from 'react-i18next';
import {AnimatePresence,motion} from 'framer-motion';
import {TestAuth} from 'test-auth';
import {AppearancePanel} from ${modulePath('components/AppearancePanel.tsx')};
import {executeAppearanceWorkspace} from ${modulePath('lib/appearance-service.ts')};
import {ChatLayoutPanel,ChatLayoutConfirmation,ChatLayoutPreviewBar} from ${modulePath('components/ChatLayoutPanel.tsx')};
import {useChatLayouts} from ${modulePath('lib/chat-layout-service.ts')};
import {setNotebookDraftState,setToolsPanelState} from ${modulePath('lib/tools.ts')};
import notebook from ${modulePath('components/NotebookTool.module.scss')};
import {CHAT_LAYOUT_CAPABILITIES,DEFAULT_CHAT_LAYOUT} from ${modulePath('lib/chat-layout-schema.ts')};
import {ToolsPanel,ToolsHeaderButton,ToolsToolbar} from ${modulePath('components/ToolsPanel.tsx')};
import {ChatWorkspaceBar,ChatWorkspaceTabs} from ${modulePath('components/ChatWorkspaceTabs.tsx')};
import {useChatWorkspace} from ${modulePath('lib/chat-workspace.ts')};
import {AppearanceController} from ${modulePath('components/AppearanceController.tsx')};
import {AppearanceConfirmation} from ${modulePath('components/AppearanceConfirmation.tsx')};
import {ConfirmationCard,ConfirmationQueue,ConfirmationFileDiff} from ${modulePath('components/ConfirmationCard.tsx')};
import {useConfirmationComposer} from ${modulePath('lib/useConfirmationComposer.ts')};
import {useConfirmationBridge} from ${modulePath('lib/useConfirmationBridge.ts')};
import {RejectWithComment} from ${modulePath('components/RejectWithComment.tsx')};
import {newAppearance} from ${modulePath('lib/appearance-schema.ts')};
import {previewAppearance,animateMessageArrival,getAppearancePreview} from ${modulePath('lib/appearance-runtime.ts')};
import {appearanceColors,contrastRatio} from ${modulePath('lib/appearance-colors.ts')};
import {ToolActivityCall} from ${modulePath('components/ToolActivity.tsx')};
import {WorkLog} from ${modulePath('components/WorkLog.tsx')};
import {splitWorkContent} from ${modulePath('lib/work-log-content.ts')};
import {ReasoningDisclosure} from ${modulePath('components/ReasoningDisclosure.tsx')};
import {useMessageArrival} from ${modulePath('lib/use-message-arrival.ts')};
import {ChatComposerDock} from ${modulePath('components/ChatComposerDock.tsx')};
import {ConfirmationCard} from ${modulePath('components/ConfirmationCard.tsx')};
import {ChatMessagesScroll} from ${modulePath('components/ChatMessagesScroll.tsx')};
import {VirtualMessage} from ${modulePath('components/VirtualMessage.tsx')};
import {MarkdownRenderer} from ${modulePath('components/MarkdownRenderer.tsx')};
import {setThemePreference} from ${modulePath('lib/theme.ts')};
import ru from ${modulePath('i18n/locales/ru/translation.json')};
import chat from ${modulePath('pages/ChatPage.module.scss')};
import ${modulePath('global.scss')};
window.newAppearance=newAppearance;window.previewAppearance=previewAppearance;window.appearanceColors=appearanceColors;window.contrastRatio=contrastRatio;window.light=()=>setThemePreference("light");
window.messageViewport=()=>document.querySelector('.'+chat.messages);
window.notebookList=()=>document.querySelector('.'+notebook.notesList);
window.testAccount=1;window.testDb={};window.layoutDb={};window.forceOldThemeServer=true;
window.callThemeTool=payload=>executeAppearanceWorkspace(payload,profile=>{window.lastLocalThemeProposal=profile;});
localStorage.setItem('chatter_user',JSON.stringify({id:1}));
window.localDrafts={};window.localThemeHistory={};window.localThemeMigrated={};window.themeLocations={};
const localThemeListeners=new Set();
window.emitThemeChange=()=>{for(const listener of localThemeListeners)listener();};
const localThemeSnapshot=userId=>{
 const appearance=window.testDb[userId]??{version:1,revision:0,activeId:null,profiles:[]};
 const drafts=window.localDrafts[userId]??={};
 for(const profile of appearance.profiles)drafts[profile.id]??=structuredClone(profile);
 const directory=window.themeLocations[userId]??('C:/TestThemes/'+userId);
 return {appearance:structuredClone(appearance),workspace:{directory,draftsDirectory:directory+'/.drafts',documentation:directory+'/THEMES.md',activeId:appearance.activeId,
  migrationComplete:!!window.localThemeMigrated[userId],migrationErrors:[],issues:[],
  profiles:appearance.profiles.map(profile=>({id:profile.id,name:profile.name,directory:directory+'/.saved/'+profile.id,draftDirectory:directory+'/.drafts/'+profile.id,hasPrevious:!!window.localThemeHistory[userId]?.[profile.id]})),
  drafts:Object.keys(drafts).map(id=>({id,directory:directory+'/.drafts/'+id}))}};
};
window.electronAPI={onToolWindowClosed:()=>()=>{},
 onLocalAppearanceChanged:listener=>{localThemeListeners.add(listener);return()=>localThemeListeners.delete(listener);},
 localAppearance:async payload=>{
  if('scope' in payload)throw new Error('Local themes must not be scoped to an account/server');
  await new Promise(resolve=>setTimeout(resolve,5));
  const userId=1;
  if(payload.action==='docs')return {readme:window.themeGuideText??'# Local desktop guide',desktopVersion:'test-desktop',workspace:localThemeSnapshot(userId).workspace};
  if(payload.action==='migrate'){
   if(!window.localThemeMigrated[userId])window.testDb[userId]??=structuredClone(payload.legacy);
   window.localThemeMigrated[userId]=true;
  } else if(payload.action==='change'){
   if(window.failSave){window.failSave=false;throw {data:{error:'appearance_conflict'}};}
   const current=window.testDb[userId]??={version:1,revision:0,activeId:null,profiles:[]},command=payload.command;
   if(command.action==='save'){
    const profile=structuredClone(command.profile),old=current.profiles.find(item=>item.id===profile.id);
    profile.revision=(old?.revision??0)+1;
    if(old){(window.localThemeHistory[userId]??={})[profile.id]=old;}
    current.profiles=[...current.profiles.filter(item=>item.id!==profile.id),profile];
    if(command.apply)current.activeId=profile.id;
   }else if(command.action==='activate')current.activeId=command.id;
   else if(command.action==='delete'){current.profiles=current.profiles.filter(item=>item.id!==command.id);if(current.activeId===command.id)current.activeId=null;delete window.localDrafts[userId]?.[command.id];}
   current.revision++;
  } else if(payload.action==='read-draft'){
   const profile=structuredClone(window.localDrafts[userId]?.[payload.id]);
   if(!profile)throw new Error('appearance_not_found');
   profile.revision=window.testDb[userId]?.profiles.find(item=>item.id===profile.id)?.revision??0;
   return profile;
  } else if(payload.action==='write-draft'){
   (window.localDrafts[userId]??={})[payload.profile.id]=structuredClone(payload.profile);
  } else if(payload.action==='prepare'){
   (window.localDrafts[userId]??={})[payload.id]??=window.newAppearance(payload.id);
  } else if(payload.action==='choose-directory')window.themeLocations[userId]='C:/ChosenThemes/'+userId;
  else if(payload.action==='open')window.openedThemeFolder=payload.id??'root';
  return localThemeSnapshot(userId);
 }};window.peekThemePreview=getAppearancePreview;window.animationCount=0;window.motionSamples=[];
const nativeAnimate=Element.prototype.animate;
Element.prototype.animate=function(...args){
 if(this.hasAttribute('data-message-id'))window.animationCount++;
 if(this.hasAttribute('data-motion-sample'))window.motionSamples.push(args);
 return nativeAnimate.apply(this,args);
};
function Conversation({mode='floating'}={}){
 const [items,setItems]=useState(()=>Array.from({length:60},(_,n)=>({id:n+1,content:'# Message '+(n+1)+'\n\n'+Array.from({length:12},()=> 'A paragraph with **formatting** and words to wrap.').join('\n\n')})));
 const [chatId,setChatId]=useState(1),[extra,setExtra]=useState("none");window.setComposerExtra=setExtra;
 useMessageArrival(items,chatId,true);
 const ref=useRef(null);window.scrollRef=ref;
 window.appendMessage=()=>setItems(prev=>[...prev,{id:prev.at(-1).id+1,content:'New message'}]);
 window.prependMessage=()=>setItems(prev=>[{id:-10,content:'Earlier message'},...prev]);
 window.switchChat=()=>setChatId(id=>id+1);
 return <><ChatMessagesScroll ref={ref} className={chat.messages} contentClassName={chat.messagesContent} resetKey={chatId} virtualize>
  {items.map(item=><VirtualMessage id={item.id} key={item.id} revision={item}>
   <div data-message-id={item.id} className={chat.messageGroup}>
    <div className={chat.messageIdentity}><span>Vega</span><span className={chat.messageTime}>23:11</span></div>
    <ReasoningDisclosure content="Reasoning text" streaming={false} open={false} onToggle={()=>{}} tokens={141}/>
    <ToolActivityCall call={{id:'search-'+item.id,name:'search_web',arguments:{query:'Interface design'},result_preview:'Done'}}/>
    <div className={item.id%2?chat.bubbleText:chat.bubbleUser}><MarkdownRenderer content={item.content}/></div>
   </div>
  </VirtualMessage>)}
 </ChatMessagesScroll><ChatComposerDock mode={mode}><div className={chat.composerWrap}>
 {extra==='image'&&<div className={chat.imagePreviews}><div style={{height:56,width:56}}>Image</div></div>}
 <div className={chat.composerBody}><div className={chat.composerReview}>
 {(extra==='card'||extra==='large')&&<ConfirmationCard id="dock-check" title="Confirmation" actions={<button>Apply</button>}><div style={{height:extra==='large'?1200:120}}>Review</div></ConfirmationCard>}
 </div><div className={chat.inputArea}><textarea aria-label="Dock input" rows={2}/><button>Send</button></div></div>
 <div className={chat.composerFootnote}>Enter to send</div></div></ChatComposerDock></>;

}
const testChats=[{id:101,title:'Рабочий чат'},{id:102,title:'Второй чат'}];
function AnswerSample({phase}){
 const s=chat;
 const msg={role:'assistant',intermediate_messages:phase==='reasoning'?[]:['Checking the files.']};
 const displayedVariantContent=phase==='reasoning'?'':phase==='draft'?'Checking the files.\n\nPartial answer':'Checking the files.\n\nFinal answer';
 const isGenerating=phase!=='final',isStreamingContent=phase==='draft',isStreamingReasoning=phase==='reasoning';
 const isEditing=false,isOwnUser=false,isVariantMorphing=false,isRegenerating=false;
 const searchHighlightQuery='',questionnaire=undefined,onSetViewerImageSrc=()=>{},onMessageLink=()=>{};
 ${answerState}
 return <div className={s.layout} data-layout-messages="bubbles" data-answer-sample
   style={{position:'absolute',top:90,left:'25%',right:0,width:'75%',height:'auto',padding:20,zIndex:95}}>
  <div className={s.messageGroupAssistant}>
   <WorkLog messages={workContent.messages} generating={isGenerating} draft={isGenerating?workContent.answer:undefined}/>
   ${answerBubble}
  </div>
 </div>;
}
function LayoutFixture({initialEditor=true}){
 const {t}=useTranslation();
 const layouts=useChatLayouts();
 const [appearanceShell,setAppearanceShell]=useState(null),[shellOpen,setShellOpen]=useState(false),[shellView,setShellView]=useState('conversation');
 window.enableShellReturn=()=>{setAppearanceShell({scope:'navigator'});setShellOpen(false);setShellView('conversation');};
 const [editor,setEditor]=useState(initialEditor),[draft,setDraft]=useState(),[preview,setPreview]=useState(),[proposal,setProposal]=useState();
 const active=layouts.state?.profiles.find(item=>item.id===layouts.state.activeId);
 const layout=preview?.profile??active??DEFAULT_CHAT_LAYOUT;
 const [activeChatId,setActiveChatId]=useState(window.testActiveChat??101);
 const [chats,setVisibleChats]=useState(testChats);
 window.filterWorkspaceChats=()=>setVisibleChats(testChats.slice(0,1));
 const tabsEnabled=layout.chatSide==='top';
 ${libraryState}
 window.shellReturnState={open:shellOpen,view:shellView,activeChatId,libraryOpen};
 const workspace=useChatWorkspace('fixture:'+window.testAccount,activeChatId,chats,tabsEnabled);
 ${workspaceTitle}
 window.workspaceChatTitle=activeChatTitle;
 const setRoomOpen=()=>{};
 const selectChat=id=>{setActiveChatId(id);window.testActiveChat=id;if(libraryOpen)closeChatLibrary();};
 const closeWorkspaceTab=id=>{
  workspace.removeTab(id);
  if(id===activeChatId)selectChat(workspace.tabs.find(tab=>tab.id!==id)?.id??null);
 };
 window.openLayoutEditor=()=>setEditor(true);
 window.closeLayoutEditor=()=>setEditor(false);
 window.resetWorkspaceTools=()=>{
  setNotebookDraftState({title:'',content:'',isOpen:false});
  setToolsPanelState({isOpen:false,openTools:[]});
 };
 window.layoutProposal=()=>setProposal({proposal_id:'layout-bot',profile:{...CHAT_LAYOUT_CAPABILITIES.template,name:'Bot layout',id:'from-bot-layout',chatSide:'left'}});
 const s=chat, sidebarCollapsed=false, sidebarWidth=layout.sidebarWidth??260;
 ${shellReturnButton}
 const [notifications,setNotifications]=useState(false);
 const [answerSample,setAnswerSample]=useState(null);
 window.setAnswerSample=setAnswerSample;
 const chatSidebar=(
 ${libraryFrame}
  <input ref={librarySearch} aria-label="Library search"/>
  <div className={chat.sidebarContentBody} data-library-scroll>
   <details open><summary>Folder</summary>{testChats.map(item=><button key={item.id} onClick={()=>selectChat(item.id)}>{item.title}</button>)}</details>
   {Array.from({length:65},(_,i)=><div key={i} className={chat.chatItem}>Chat {i+1}</div>)}
  </div>
  <div className={chat.sidebarFooter}>
   <button className={chat.userInfo} data-library-settings onClick={()=>setEditor(true)}>Settings</button>
   <button className={chat.iconBtn} data-library-notifications aria-pressed={notifications} onClick={()=>setNotifications(value=>!value)}>Notifications</button>
  </div>
 </motion.aside>);
 const toolsSidebar=<ToolsPanel key="tools" placement={layout.tools} side={layout.chatSide==='right'?'left':'right'} plan="free" isAdmin={0}/>;
 const roomSidebar=null;
 const conversation=<main key="conversation" className={chat.main}>
  ${shellNavigation}
  ${workspaceBar}
  {preview&&<ChatLayoutPreviewBar profile={preview.profile} layouts={layouts} fromSettings={preview.editor}
   onClose={()=>{if(preview.editor){setDraft(preview.profile);setEditor(true);}setPreview(undefined);}}
   onApply={()=>{if(!preview.editor)setProposal(undefined);setPreview(undefined);}}/>}
  {layout.tools==='header'&&<div className={chat.chatTopBar}><ToolsHeaderButton className={chat.chatFindTrigger} onOpen={()=>{}}/></div>}
  <Conversation mode={layout.composer}/>
  {proposal&&<div style={{position:'absolute',bottom:12,left:0,right:0,zIndex:60}}>
    <ChatLayoutConfirmation proposal={proposal} layouts={layouts} onPreview={()=>setPreview({profile:proposal.profile,editor:false})}
        onResolved={()=>{setProposal(undefined);setPreview(undefined);}}/>
  </div>}
 </main>;
 return <div className={chat.layout} data-layout-side={layout.chatSide} data-layout-column={layout.column}
  data-layout-density={layout.chatList} data-layout-messages={layout.messages} data-layout-custom={!!(active||preview)}>
  ${libraryBackdrop}
  ${shellOrder}
  {answerSample&&<AnswerSample phase={answerSample}/>}
  {editor&&<div id="layout-editor-fixture" style={{position:'absolute',zIndex:95,top:20,left:20,width:'min(680px, 90vw)',maxHeight:'90vh',overflow:'auto',background:'var(--bg-primary)',padding:20}}>
   <ChatLayoutPanel layouts={layouts} initialDraft={draft} onPreview={profile=>{setPreview({profile,editor:true});setEditor(false);}}/>
  </div>}
 </div>;
}
function WrappedQueueCard({proposal,...props}){return <ConfirmationCard {...props} id={proposal.proposal_id} title="Second request"
 actions={<button onClick={()=>{window.queueCalls.push('second');}}>Approve second</button>}>Second request details</ConfirmationCard>;}
function QueueFixture(){
 const [request,setRequest]=useState(null),composer=useConfirmationComposer(1),bridge=useConfirmationBridge();
 const [custom,setCustom]=useState(false),[password,setPassword]=useState(''),[remember,setRemember]=useState(false),[unsupported,setUnsupported]=useState(false);
 window.enableCustomConfirmations=()=>setCustom(true);window.setUnsupportedConfirmation=setUnsupported;
 window.projectedConfirmations=bridge.cards;window.runProjectedConfirmation=(...args)=>bridge.api.execute(...args);window.setProjectedField=(...args)=>bridge.api.change(...args);
 window.pickRequest=id=>setRequest({id});window.queueCalls??=[];
 const UnknownBody=()=> <p>Unsupported native widget</p>;
 const items=[<ConfirmationCard key="first" id="first" title="First request" actions={<><button onClick={async()=>{window.queueLastValues={password,remember};window.queueCalls.push('first');await new Promise(resolve=>{window.finishQueueAction=resolve;});}}>Approve first</button><RejectWithComment onReject={text=>{window.queueLastComment=text;}}/></>}>
 First request details<label>Password<input type="password" value={password} onChange={event=>setPassword(event.target.value)}/></label><label>Remember<input type="checkbox" checked={remember} onChange={event=>setRemember(event.target.checked)}/></label><ConfirmationFileDiff oldContent="before source" newContent="after source"/>{unsupported&&<UnknownBody/>}</ConfirmationCard>,
 <WrappedQueueCard key="second" proposal={{proposal_id:'second'}}/>];
 return <ConfirmationQueue items={items} composer={composer} order={new Map([['first',1],['second',2]])} request={request}
   bridge={custom?bridge.api:undefined} custom={custom&&!bridge.cards.some(card=>!card.customizable)}/>;
}
function App(){
 const [user,setUser]=useState({id:1,ui_settings:{}}),[proposal,setProposal]=useState(null),[layoutFixture,setLayoutFixture]=useState(false);
 const [workspaceEpoch,setWorkspaceEpoch]=useState(0);
 const [queueFixture,setQueueFixture]=useState(false);window.openQueueFixture=()=>setQueueFixture(true);
 window.openLayoutFixture=()=>setLayoutFixture(true);
 window.reloadWorkspace=()=>setWorkspaceEpoch(epoch=>epoch+1);
 window.logoutAccount=()=>{localStorage.removeItem('chatter_user');setUser(null);};
 window.changeAccount=()=>{window.testAccount=2;window.forceOldThemeServer=false;localStorage.setItem('chatter_user',JSON.stringify({id:2}));setUser({id:2,ui_settings:{}});};
 window.propose=()=>setProposal({proposal_id:'bot-proposal',profile:{...newAppearance('from-bot'),name:'Bot look'}});
 window.proposeDraft=()=>setProposal({proposal_id:'bot-draft',profile:{...newAppearance('saved-bot'),name:'Saved bot draft'}});
 window.motionPreview=()=>previewAppearance({...newAppearance('motion'),motion:{preset:'custom',duration:100,distance:12,scale:0.97,easing:'ease-out'}});
 window.dark=()=>{setThemePreference('dark');window.dispatchEvent(new CustomEvent('chatter-theme-change',{detail:'dark'}));};
 return <TestAuth.Provider value={{user,setUser}}>{queueFixture ? <QueueFixture/> : layoutFixture ? <LayoutFixture key={workspaceEpoch} initialEditor={!workspaceEpoch}/> : <><AppearanceController/>
  <div id="panel-fixture" className={chat.sidebar} style={{width:'48%',height:'100%',overflow:'auto',padding:20}}><AppearancePanel/>{proposal&&<AppearanceConfirmation proposal={proposal} onResolved={()=>setProposal(null)}/>}</div>
  <div className={chat.main} style={{width:'52%',height:'100%',display:'flex',flexDirection:'column'}}><Conversation/></div>
 </>}</TestAuth.Provider>;
}
window.clickText=text=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text&&!el.disabled&&!el.closest('details:not([open])')&&el.getBoundingClientRect().height>0);if(!button)throw new Error('Button missing: '+text);button.click();};
window.inputText=(label,value)=>{
 const input=document.querySelector('input[aria-label="'+label+'"]')??[...document.querySelectorAll('label')].find(el=>el.textContent.trim()===label)?.querySelector('input');
 if(!input)throw new Error('Input missing: '+label);
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
 input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
};
window.sourceText=value=>{
 const input=document.querySelector('#panel-fixture textarea');
 if(!input)throw new Error('Source editor missing');
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);
 input.dispatchEvent(new Event('input',{bubbles:true}));
};
const i18n=createInstance();
i18n.init({lng:'ru',resources:{ru:{translation:ru}},interpolation:{escapeValue:false}}).then(()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 window.reloadLocalAppearance=()=>client.resetQueries({queryKey:['appearance']});
 createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><I18nextProvider i18n={i18n}><App/></I18nextProvider></QueryClientProvider>);
 window.fixtureReady=true;
});
`;

const electronFixture = String.raw`
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'user-data'));
setTimeout(()=>{console.error('Appearance UI timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,useContentSize:true,webPreferences:{offscreen:true,sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents,errors=[];
 wc.on('console-message',(_event,level,message)=>{if(level===3)errors.push(message);});
 wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,cb)=>cb({cancel:true}));
 const js=async code=>{try{return await wc.executeJavaScript(code);}catch(error){console.error('Failed JS:',code);console.error('Renderer errors:',errors);throw error;}},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async code=>{for(let n=0;n<120;n++){if(await js(code))return;await sleep(25);}throw new Error('Timed out: '+code+'\nRenderer errors: '+errors.join('\n'));};
 await win.loadFile(path.join(__dirname,'renderer/index.html'));
 await until('window.fixtureReady && [...document.querySelectorAll("button")].some(el=>el.textContent==="Создать оформление")');
 assert.ok(await js('window.migrationRequests.some(item=>item.userId===1&&item.path.endsWith("/legacy"))&&window.migrationRequests.some(item=>item.userId===1&&item.path==="/api/v1/user/appearance")'),'older-server migration fallback is supported');
 await until('document.querySelectorAll("[data-virtual-row-placeholder]").length>30');
 // The floating dock must reserve space without shrinking or recoloring the viewport.
 const dockMetrics=()=>js('(()=>{const v=window.messageViewport(),dock=document.querySelector("[data-chat-composer-dock]"),input=dock.querySelector("textarea"),last=[...document.querySelectorAll("[data-message-id]")].at(-1);return {height:v.clientHeight,bottom:v.getBoundingClientRect().bottom,dockTop:dock.getBoundingClientRect().top,inputBottom:input.getBoundingClientRect().bottom,reserve:parseFloat(v.parentElement.style.getPropertyValue("--chat-composer-height")),lastBottom:last.getBoundingClientRect().bottom,background:getComputedStyle(v).backgroundImage};})()');
 await until('parseFloat(window.messageViewport().parentElement.style.getPropertyValue("--chat-composer-height"))>0');
 const initialDock=await dockMetrics();
 for(const kind of ['image','card','large','none']){
  await js('window.setComposerExtra('+JSON.stringify(kind)+')');
  await until('Math.abs(parseFloat(window.messageViewport().parentElement.style.getPropertyValue("--chat-composer-height"))-document.querySelector("[data-chat-composer-dock]").getBoundingClientRect().height)<1');
  await sleep(100);
  const next=await dockMetrics();assert.equal(next.height,initialDock.height,'extras must not shrink message viewport');
  assert.ok(next.inputBottom<=next.bottom,'input remains visible even with a large confirmation');
  assert.ok(next.lastBottom<=next.dockTop+1,'last message remains above floating composer '+kind+' '+JSON.stringify(next));
  assert.equal(next.background,initialDock.background);
 }
 const originalHeight=await js('window.scrollRef.current.getMetrics().scrollHeight');
 await js('window.clickText("Создать оформление")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.inputText("Название","My evening");window.inputText("Размер сообщений",22);window.inputText("Шрифт сообщений","Georgia");window.inputText("Плотность",1.2)');
 const motionLabel='Появление сообщения';
 const motionMenu='[...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")==='+JSON.stringify(motionLabel)+')';
 const pickMotion=async label=>{
  await js(motionMenu+'.click()');
  await until('[...document.querySelectorAll("button")].some(el=>el!=='+motionMenu+' && el.textContent.trim()==='+JSON.stringify(label)+')');
  await js('[...document.querySelectorAll("button")].find(el=>el!=='+motionMenu+' && el.textContent.trim()==='+JSON.stringify(label)+').click()');
 };
 await pickMotion('Лёгкий масштаб');
 await js('window.clickText("Проиграть")');
 const scalePreview=await js('window.motionSamples.at(-1)');
 assert.equal(scalePreview[0][0].transform,'translateY(0px) scale(0.97)');
 assert.equal(scalePreview[1].duration,240);
 await pickMotion('Мягкий подъём');
 await js('window.clickText("Проиграть")');
 const risePreview=await js('window.motionSamples.at(-1)');
 assert.equal(risePreview[0][0].transform,'translateY(8px) scale(1)');
 assert.equal(risePreview[1].duration,220);
 await js('window.inputText("Длительность, мс",180)');
 await until(motionMenu+'.textContent.trim()==="Свой вариант"');
 await js('window.clickText("Проиграть")');
 assert.equal(await js('window.motionSamples.at(-1)[1].duration'),180);
 assert.equal(await js('window.testDb[1]?.profiles.length??0'),0,'replaying a draft must not save it');

 await js('window.clickText("Сохранить вариант")');
 await until('window.testDb[1]?.profiles.length===1');
 assert.deepEqual(await js('window.testDb[1].profiles[0].motion'),{preset:'custom',duration:180,distance:8,scale:1,easing:'ease-out'});

 assert.equal(await js('document.documentElement.dataset.appearance??null'),null,'saving a variant must not activate it');
 assert.equal(await js('window.testDb[1].activeId'),null);
 await js('window.clickText("Изменить")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.inputText("Название","Preview change");window.clickText("Предпросмотр")');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 assert.equal(await js('window.testDb[1].profiles[0].name'),'My evening','preview must not mutate stored data');
 await until('window.scrollRef.current.getMetrics().scrollHeight>'+originalHeight);
 const type=await js('(()=>{const md=document.querySelector("[data-message-id] h1").parentElement;return {font:getComputedStyle(md).fontFamily,size:getComputedStyle(md).fontSize};})()');
 assert.ok(type.font.includes('Georgia'));assert.equal(type.size,'22px');
 await js('window.clickText("Вернуть оформление")');
 await until('!document.documentElement.dataset.appearance');
 await until('Math.abs(window.scrollRef.current.getMetrics().scrollHeight-'+originalHeight+')<=2');
 // Apply from the recovery bar: the editor must resolve rather than keep a stale revision.
 await js('window.clickText("Предпросмотр")');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 await js('(()=>{const bar=document.querySelector("[aria-label=Предпросмотр]");[...bar.querySelectorAll("button")].find(el=>el.textContent==="Сохранить и применить").click();})()');
 await until('window.testDb[1].activeId!==null && !document.querySelector("input[list=appearance-fonts]")');
 await js('window.dark()');
 assert.equal(await js('document.documentElement.style.getPropertyValue("--bg-secondary")'),'#101722');
 // A bot proposal follows the same preview/apply flow and disappears when applied from the bar.
 await js('window.propose()');
 await until('!!document.querySelector("[data-confirmation-id=bot-proposal]") || document.body.textContent.includes("Bot look")');
 await js('window.clickText("Предпросмотр")');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 await js('(()=>{const bar=document.querySelector("[aria-label=Предпросмотр]");[...bar.querySelectorAll("button")].find(el=>el.textContent==="Сохранить и применить").click();})()');
 await until('window.testDb[1].activeId==="from-bot" && !document.body.textContent.includes("Предложение оформления")');
 await js('window.proposeDraft()');
 await until('document.body.textContent.includes("Saved bot draft")');
 await js('window.clickText("Сохранить вариант")');
 await until('window.testDb[1].profiles.length===3 && !document.body.textContent.includes("Предложение оформления")');
 assert.equal(await js('window.testDb[1].activeId'),'from-bot','saving a bot variant must not change active appearance');
 // Set each region through the real editor, preview without saving, and reset to Auto.
 await js('window.light();window.clickText("Изменить")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.inputText("Светлая палитра Панели и окна","#081a2b");window.inputText("Светлая палитра Однотонный фон переписки","#253443");window.clickText("Предпросмотр")');
 await until('document.documentElement.dataset.appearancePanels==="custom"');
 assert.equal(await js('getComputedStyle(document.querySelector("#panel-fixture")).backgroundColor'),'rgb(8, 26, 43)');
 assert.equal(await js('getComputedStyle(window.messageViewport()).backgroundColor'),'rgb(37, 52, 67)');
 assert.notEqual(await js('getComputedStyle(document.body).color'),await js('getComputedStyle(document.querySelector("#panel-fixture")).color'));
 await js('[...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")==="Светлая палитра Панели и окна Авто").click()');
 await until('!document.documentElement.dataset.appearancePanels');
 await js('window.clickText("Вернуть оформление");window.clickText("Отмена")');
 // Reproduce a dark Mass Effect gradient while the shell remains light.
 await js('window.light();window.previewAppearance({...window.newAppearance("contrast"),typography:{...window.newAppearance().typography,uiSize:18},geometry:{radius:0,density:1.2},background:{...window.newAppearance().background,type:"gradient",color:"#04101e",color2:"#12365a"}})');
 await until('document.documentElement.dataset.appearance==="contrast"');
 const contrast=await js('(()=>{const hex=rgb=>"#"+rgb.match(/\\d+/g).slice(0,3).map(n=>Number(n).toString(16).padStart(2,"0")).join("");const row=document.querySelector("[data-message-id]");const heading=row.querySelector("h1"),summary=row.querySelector("summary"),reasoning=row.querySelector("button"),md=heading.parentElement;return {body:hex(getComputedStyle(md).color),hint:getComputedStyle(reasoning).color,shell:getComputedStyle(document.body).color,tool:hex(getComputedStyle(summary).color),toolBg:hex(getComputedStyle(summary).backgroundColor),radius:getComputedStyle(summary).borderRadius,size:getComputedStyle(summary.parentElement).fontSize,backdrop:getComputedStyle(window.messageViewport()).backgroundImage};})()');
 assert.ok(await js('window.contrastRatio('+JSON.stringify(contrast.body)+',"#04101e")>=4.5 && window.contrastRatio('+JSON.stringify(contrast.body)+',"#12365a")>=4.5'),'message ink must contrast with both gradient stops');
 assert.ok(await js('window.contrastRatio('+JSON.stringify(contrast.tool)+','+JSON.stringify(contrast.toolBg)+')>=4.5'),'tool surface contrast');
 assert.equal(contrast.radius,'0px','work log tool corners follow appearance');
 assert.ok(Math.abs(parseFloat(contrast.size)-12*18/14)<0.01,'work log font size follows interface size');
 assert.notEqual(contrast.hint,contrast.shell,'reasoning must inherit the chat palette rather than the light shell');
 await sleep(250);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-appearance-contrast-light.png'),(await wc.capturePage()).toPNG());
 await js('window.dark()');await sleep(100);
 const darkInk=await js('getComputedStyle(document.querySelector("[data-message-id] h1").parentElement).color');
 assert.notEqual(darkInk,'rgb(15, 29, 48)');
 await js('window.clickText("Вернуть оформление")');
 await until('document.documentElement.dataset.appearance==="from-bot"');
 // Real renderer/editor materials: only surfaces change opacity; text stays fully opaque.
 await js('window.clickText("Изменить")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.clickText("Настроить материал")');
 await js('window.clickText("Настроить материал")');
 await js('window.clickText("Предпросмотр")');
 await until('document.documentElement.dataset.materialPanels==="custom" && document.documentElement.dataset.materialComposer==="custom"');
 const materialStyle=await js('(()=>{const panel=document.querySelector("#panel-fixture"),input=document.querySelector("[data-chat-composer-dock] textarea"),surface=input.parentElement;return {panelFilter:getComputedStyle(panel).backdropFilter,filter:getComputedStyle(surface).backdropFilter,fill:getComputedStyle(surface).backgroundColor,opacity:getComputedStyle(input).opacity,shadow:getComputedStyle(surface).boxShadow};})()');
 assert.equal(materialStyle.panelFilter,'blur(16px)'); assert.equal(materialStyle.filter,'blur(16px)');
 assert.equal(materialStyle.opacity,'1');assert.notEqual(materialStyle.shadow,'none');assert.ok(materialStyle.fill.startsWith('rgba('));
 await js('[...document.querySelectorAll("h4")].find(el=>el.textContent==="Материалы поверхностей").scrollIntoView({block:"start"});window.scrollRef.current.scrollTo(0,{immediate:true})');
 await sleep(250);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-materials-review.png'),(await wc.capturePage()).toPNG());
 await js('window.scrollRef.current.scrollTo("end",{immediate:true})');

 // A mid-grey fill previously jumped from 80% to 100%. Check the actual CSS
 // and captured pixels, so an opaque ancestor/child cannot hide behind a rgba assertion.
 await js('(()=>{const p=window.newAppearance("alpha-regression");p.light.surface=p.dark.surface="#777777";p.materials={panels:{opacity:0.8,blur:16,shadow:"soft",border:"subtle"},composer:{opacity:0.8,blur:16,shadow:"soft",border:"subtle"}};window.previewAppearance(p);const bg=document.createElement("div");bg.id="alpha-backdrop";bg.style.cssText="position:absolute;z-index:1;bottom:0;left:0;right:0;height:220px;background:rgb(255,0,0);pointer-events:none";window.messageViewport().parentElement.append(bg);})()');
 await until('document.documentElement.dataset.appearance==="alpha-regression"');
 const actualFill=await js('getComputedStyle(document.querySelector("[data-chat-composer-dock] textarea").parentElement).backgroundColor');
 assert.ok(/rgba\(119, 119, 119, 0\.8\)/.test(actualFill),actualFill);
 const panelFill=await js('getComputedStyle(document.querySelector("#panel-fixture")).backgroundColor');
 assert.equal(panelFill,actualFill,'panel and composer both retain requested alpha');
 const samplePixel=async()=>{
  const box=await js('(()=>{const r=document.querySelector("[data-chat-composer-dock] textarea").parentElement.getBoundingClientRect();return {x:r.right-30,y:r.top+r.height/2};})()');
  await sleep(100);await wc.capturePage();await sleep(75);const shot=await wc.capturePage(),size=shot.getSize(),screen=win.getContentSize();
  const x=Math.floor(box.x*size.width/screen[0]),y=Math.floor(box.y*size.height/screen[1]),offset=(y*size.width+x)*4;
  return [...shot.toBitmap().subarray(offset,offset+3)];
 };
 const red=await samplePixel();
 await js('document.querySelector("#alpha-backdrop").style.background="rgb(0,0,255)"');
 const blue=await samplePixel();
 assert.ok(red.some((channel,i)=>Math.abs(channel-blue[i])>10),'changing the backdrop must be visible through the composer: '+JSON.stringify({red,blue}));
 await js('document.querySelector("#alpha-backdrop").remove();window.clickText("Предпросмотр")');
 await wc.debugger.attach('1.3');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
 const fallback=await js('getComputedStyle(document.querySelector("[data-chat-composer-dock] textarea").parentElement).backdropFilter');
 assert.equal(fallback,'none');
 assert.equal(await js('getComputedStyle(document.querySelector("[data-material-fallback]")).display'),'block','the opaque system override must be visible in the editor');
 await wc.debugger.detach();
 await js('[...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")==="Поле ввода Авто").click()');
 await until('!document.documentElement.dataset.materialComposer');
 assert.equal(await js('getComputedStyle(document.querySelector("[data-chat-composer-dock] textarea").parentElement).backdropFilter'),'none');
 await js('window.clickText("Вернуть оформление");window.clickText("Отмена")');
 assert.ok(await js('!document.documentElement.dataset.materialComposer && !document.documentElement.dataset.materialPanels'));
 // Animation is tied to append events, never to row remounts or prepending history.
 await js('window.motionPreview()');
 await js('window.appendMessage()');
 await until('window.animationCount===1');
 await js('window.scrollRef.current.scrollTo(0,{immediate:true})');
 await sleep(100);
 await js('window.scrollRef.current.scrollTo("end",{immediate:true})');
 await sleep(100);
 assert.equal(await js('window.animationCount'),1,'virtual row remounts must not replay arrival');
 await js('window.prependMessage()');
 await sleep(100);assert.equal(await js('window.animationCount'),1);
 await js('window.switchChat()');await sleep(100);assert.equal(await js('window.animationCount'),1);
 await wc.debugger.attach('1.3');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await js('window.appendMessage()');await sleep(100);assert.equal(await js('window.animationCount'),1,'reduced motion must suppress arrival');
 await wc.debugger.detach();
 await js('window.motionPreview()');
 await js('window.dispatchEvent(new KeyboardEvent("keydown",{code:"Backspace",key:"Backspace",ctrlKey:true,altKey:true,bubbles:true}))');
 await until('window.testDb[1].activeId===null && !document.documentElement.dataset.appearance');
 // Account changes and logout retain the shared selection, library and preview.
 await js('window.electronAPI.localAppearance({action:"change",command:{action:"activate",id:window.testDb[1].profiles[0].id}}).then(()=>window.emitThemeChange())');
 await until('document.documentElement.dataset.appearance===window.testDb[1].activeId');
 const selectedBeforeAccount=await js('window.testDb[1].activeId');
 await js('window.motionPreview();window.changeAccount()');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 assert.equal(await js('window.peekThemePreview().id'),'motion');
 assert.equal((await js('window.callThemeTool({action:"docs"})')).state.activeId,selectedBeforeAccount);
 await js('window.logoutAccount()');
 await sleep(50);
 const requestsBeforeLoggedOutReload=await js('window.migrationRequests.length');
 await js('window.reloadLocalAppearance()');
 await until('document.documentElement.dataset.appearance==="motion"');
 assert.equal(await js('window.migrationRequests.length'),requestsBeforeLoggedOutReload,'loading local themes while signed out needs no server request');
 assert.equal((await js('window.callThemeTool({action:"docs"})')).state.activeId,selectedBeforeAccount);
 assert.equal(await js('window.testDb[1].profiles.length'),3);
 await js('window.changeAccount();window.previewAppearance(null)');
 await until('document.documentElement.dataset.appearance===window.testDb[1].activeId');
 assert.deepEqual(errors,[]);
 // Start the separate project-editor scenario with an empty fixture library.
 await js('window.testDb[1]={version:1,revision:0,activeId:null,profiles:[]};window.localDrafts[1]={};window.emitThemeChange()');
 await until('!document.documentElement.dataset.appearance');
 // Leave a reviewable screenshot of the real catalog/editor.
 await until('[...document.querySelectorAll("button")].some(el=>el.textContent==="Создать оформление"&&!el.disabled)');
 await js('window.clickText("Создать оформление")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await sleep(400);
 await wc.capturePage();await sleep(100);
 const shot=await wc.capturePage();
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-appearance-review.png'),shot.toPNG());
 // Exercise the real project editor and compiler before applying a profile.
 await js('[...document.querySelectorAll("label")].find(label=>label.textContent.trim()==="Использовать свой экран чатов").querySelector("input").click()');
 const choose=async(label,value)=>{
  await js('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==='+JSON.stringify(label)+').click()');
  await until('[...document.querySelectorAll("[data-native-overlay] button")].some(button=>button.textContent.trim()==='+JSON.stringify(value)+')');
  await js('[...document.querySelectorAll("[data-native-overlay] button")].find(button=>button.textContent.trim()==='+JSON.stringify(value)+').click()');
 };
 await choose('Формат исходного кода','tsx');
 await js('window.sourceText("export default function App(){return <main>Project</main>}")');
 await js('window.clickText("Разделить на файлы")');
 await until('!!document.querySelector("button[aria-label=\\\"Файл проекта\\\"]")');
 assert.equal(await js('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Удалить файл").disabled'),true,'entry deletion is disabled');
 await js('window.inputText("Путь нового файла","styles.css")');
 await js('window.clickText("Добавить файл")');
 await js('window.sourceText("main { color: blue; }")');
 await choose('Файл проекта','App.tsx');
 await js('window.sourceText(\'import "./styles.css"; export default function App(){return <main>Project</main>}\')');
 await choose('Файл проекта','styles.css');
 await js('window.clickText("Удалить файл")');
 await js('window.clickText("Предпросмотр")');
 await until('[...document.querySelectorAll("#panel-fixture [role=alert]")].some(element=>element.textContent.includes("App.tsx:1:") && element.textContent.includes("styles.css"))');
 assert.equal(await js('document.documentElement.dataset.appearance??null'),null,'invalid code must not start a preview');
 await js('window.inputText("Путь нового файла","styles.css")');
 await js('window.clickText("Добавить файл")');
 await js('window.sourceText("main { color: blue; }")');
 await js('window.clickText("Предпросмотр")');
 await until('!!document.documentElement.dataset.appearance');
 await js('window.clickText("Вернуть оформление")');
 await until('!document.documentElement.dataset.appearance');
 await js('window.clickText("Сохранить вариант")');
 await until('window.testDb[1]?.profiles.length===1');
 assert.equal(await js('window.testDb[1].profiles[0].shell.files["styles.css"]'),'main { color: blue; }');
 assert.equal(await js('window.testDb[1].profiles[0].shell.entry'),'App.tsx');
 assert.equal(await js('window.testDb[1].activeId'),null);
 await js('document.querySelector("#panel-fixture details summary").click()');
 await js('window.clickText("Предпросмотр")');
 await until('window.peekThemePreview()?.id===window.testDb[1].profiles[0].id');
 await js('(()=>{const id=window.testDb[1].profiles[0].id;window.localDrafts[1][id].shell.files["styles.css"]="main { color: red; }";window.emitThemeChange();})()');
 await until('window.peekThemePreview()?.shell.files["styles.css"]==="main { color: red; }"');
 const themeId=await js('window.testDb[1].profiles[0].id');
 const themeDocs=await js('window.callThemeTool({action:"docs"})');
 assert.equal(themeDocs.readme,'# Local desktop guide');
 assert.equal(themeDocs.desktopVersion,'test-desktop');
 assert.equal(themeDocs.state.directory,await js('window.themeLocations[1]??"C:/TestThemes/1"'));
 assert.equal(themeDocs.state.activeId,null);
 assert.ok(themeDocs.state.profiles.some(profile=>profile.id===themeId));
 assert.ok(themeDocs.state.drafts.includes(themeId));
 assert.equal(JSON.stringify(themeDocs.state).includes('export default'),false,'state contains metadata only');
 await js('window.themeGuideText="# Updated local guide"');
 assert.equal((await js('window.callThemeTool({action:"docs"})')).readme,'# Updated local guide');
 await js('window.localDrafts[1]["new-draft"]=structuredClone(window.localDrafts[1]['+JSON.stringify(themeId)+'])');
 assert.ok((await js('window.callThemeTool({action:"docs"})')).state.drafts.includes('new-draft'),'each call reads current state');
 await js('delete window.localDrafts[1]["new-draft"]');
 assert.equal(await js('window.testDb[1].activeId'),null,'reading docs never applies a theme');
 assert.equal(await js('window.lastLocalThemeProposal'),undefined,'reading docs never opens a proposal');
 assert.equal((await js('window.callThemeTool({id:'+JSON.stringify(themeId)+',checkOnly:true})')).status,'valid');
 assert.equal(await js('window.lastLocalThemeProposal'),undefined);
 assert.equal((await js('window.callThemeTool({id:'+JSON.stringify(themeId)+'})')).status,'proposed');
 assert.equal(await js('window.lastLocalThemeProposal.shell.files["styles.css"]'),'main { color: red; }');
 assert.equal(await js('window.testDb[1].profiles[0].shell.files["styles.css"]'),'main { color: blue; }','watching a draft must not save or apply it');
 await js('(()=>{const id=window.testDb[1].profiles[0].id;window.validEntry=window.localDrafts[1][id].shell.files["App.tsx"];window.localDrafts[1][id].shell.files["App.tsx"]="export default function App(){return <main> }";window.emitThemeChange();})()');
 await until('document.querySelector("[aria-label=Предпросмотр] [role=alert]")?.textContent.includes("App.tsx")');
 assert.equal((await js('window.callThemeTool({id:'+JSON.stringify(themeId)+',checkOnly:true})')).error,'appearance_build_failed');
 assert.ok(await js('[...document.querySelectorAll("[aria-label=Предпросмотр] button")].find(button=>button.textContent==="Сохранить и применить").disabled'));
 await js('(()=>{const id=window.testDb[1].profiles[0].id;window.localDrafts[1][id].shell.files["App.tsx"]=window.validEntry;window.emitThemeChange();})()');
 await until('!document.querySelector("[aria-label=Предпросмотр] [role=alert]")');
 await js('window.clickText("Вернуть оформление")');
 await js('(()=>{const id=window.testDb[1].profiles[0].id;window.localDrafts[1][id].shell.files["styles.css"]="main { color: green; }";window.emitThemeChange();})()');
 await sleep(100);
 assert.equal(await js('window.peekThemePreview()'),null,'file edits after cancellation must not reopen a preview');
 assert.equal(await js('window.serverAppearanceWrites??0'),0);
 await js('window.clickText("Выбрать другой каталог")');
 await until('document.querySelector("#panel-fixture").textContent.includes("C:/ChosenThemes/1")');
 assert.equal(await js('window.testDb[1].activeId'),null,'moving the theme directory does not activate a theme');
 console.log('PASS: local draft live reload, error diagnostics and apply guard, cancellation, directory selection and no server appearance writes');
 console.log('PASS: actual project file editor, conversion without source loss, entry protection, file diagnostics before preview, and complete inactive project save');
 await js('window.openLayoutFixture()');
 await until('[...document.querySelectorAll("#layout-editor-fixture button")].some(el=>el.getAttribute("aria-label")==="Сохранённые компоновки")');
 await until('document.querySelectorAll("[data-virtual-row-placeholder]").length>30');
 await js('window.originalViewport=window.messageViewport();window.originalList=document.querySelector("[data-chat-list]");window.originalList.querySelector("details").open=false');
 await js('window.clickText("Широкая")');
 await until('!!document.querySelector("#layout-editor-fixture input[type=range]")');
 await js('window.clickText("Кнопка в шапке")');
 await js('window.inputText("Название","Wide layout")');
 await sleep(200);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-layout-review.png'),(await wc.capturePage()).toPNG());
 await js('window.clickText("Посмотреть в чате")');
 await until('document.querySelector("[data-layout-side]").dataset.layoutSide==="right" && document.querySelector("[data-composer-mode]").dataset.composerMode==="docked"');
 assert.ok(await js('window.messageViewport()===window.originalViewport && document.querySelector("[data-chat-list]")===window.originalList && !window.originalList.querySelector("details").open'));
 assert.ok(await js('window.originalList.getBoundingClientRect().left>window.messageViewport().getBoundingClientRect().left'));
 assert.equal(await js('window.layoutDb[2]'),undefined,'preview must not write settings');
 await until('Math.abs(window.messageViewport().scrollHeight-window.messageViewport().clientHeight-window.messageViewport().scrollTop)<=4');
 assert.equal(await js('window.messageViewport().parentElement.style.getPropertyValue("--chat-composer-height")'),'');
 await js('window.clickText("К настройкам")');
 await until('document.querySelector("#layout-editor-fixture input")?.value==="Wide layout"');
 assert.equal(await js('document.querySelector("[data-layout-side]").dataset.layoutSide'),'left');
 await js('window.clickText("Посмотреть в чате")');
 await until('!document.querySelector("#layout-editor-fixture")');
 await js('window.clickText("Сохранить и применить")');
 await until('!!window.layoutDb[2]?.activeId && ![...document.querySelectorAll("aside[aria-label]")].some(el=>el.getAttribute("aria-label")==="Предпросмотр компоновки")');
 win.setSize(740,810);
 await sleep(300);
 await js('document.querySelector("button[aria-controls=chat-tools-panel]").click()');
 await until('document.querySelector("#chat-tools-panel").dataset.toolsPanelOpen==="true"');
 assert.equal(await js('getComputedStyle(document.querySelector("#chat-tools-panel")).position'),'absolute');
 assert.ok(await js('window.messageViewport().clientWidth>=400'));
 await js('document.querySelector("button[aria-controls=chat-tools-panel]").click();window.layoutProposal()');
 await until('[...document.querySelectorAll("strong")].some(el=>el.textContent==="Bot layout")');
 await js('window.clickText("Посмотреть в чате")');
 await until('document.querySelector("[data-layout-side]").dataset.layoutSide==="left"');
 await js('window.clickText("Закрыть предпросмотр")');
 await until('document.querySelector("[data-layout-side]").dataset.layoutSide==="right"');
 await js('window.clickText("Сохранить")');
 await until('window.layoutDb[2].profiles.length===2');
 assert.equal(await js('window.layoutDb[2].profiles.find(p=>p.id===window.layoutDb[2].activeId).name'),'Wide layout');
 await js('window.openLayoutEditor()');
 await until('!!document.querySelector("#layout-editor-fixture input")');
 await js('window.clickText("Новая компоновка")');
 await js('window.clickText("Вкладки сверху")');
 await js('window.clickText("Полоска сверху")');
 await js('window.clickText("Посмотреть в чате")');
 await until('document.querySelector("[data-layout-side]").dataset.layoutSide==="top" && document.querySelector("[data-workspace-chat]")?.dataset.workspaceChat==="101"');
 assert.ok(await js('window.originalList===document.querySelector("#chat-library") && window.originalList.inert && window.messageViewport()===window.originalViewport'));
 await js('window.clickText("Все чаты")');
 await until('document.activeElement.getAttribute("aria-label")==="Library search"');
 assert.ok(await js('!document.querySelector("#chat-library details").open'));
 await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
 await until('document.querySelector("#chat-library").inert && document.activeElement.getAttribute("aria-controls")==="chat-library"');
 await js('window.clickText("Все чаты");document.querySelector("#chat-library details").open=true');
 await js('window.clickText("Второй чат")');
 await until('document.querySelector("[data-workspace-chat][aria-current=page]")?.dataset.workspaceChat==="102"');
 await js('[...document.querySelectorAll("button[aria-label]")].find(button=>button.getAttribute("aria-label")==="Закрепить «Второй чат»").click()');
 await until('document.querySelector("[data-workspace-chat]").dataset.workspaceChat==="102"');
 await js('window.clickText("Ещё")');
 await until('!!document.querySelector("#workspace-tool-menu")');
 await js('document.querySelector("#workspace-tool-menu > div:nth-child(3) button[aria-pressed=false][aria-label]").click()');
 await js('document.querySelector("#workspace-tool-menu > div:nth-child(3) button").click()');
 await until('document.querySelector("#chat-tools-panel").dataset.toolsPanelOpen==="true"');
 // ResizeObserver aligns the narrow panel after the viewport and scrollbar settle.
 await until('document.querySelector("#chat-tools-panel").getBoundingClientRect().top>=document.querySelector("[data-workspace-nav]").getBoundingClientRect().bottom-1');
 await js('window.clickText("Сохранить и применить")');
 await until('window.layoutDb[2].profiles.some(item=>item.id===window.layoutDb[2].activeId && item.chatSide==="top" && item.tools==="toolbar")');
 await js('window.reloadWorkspace()');
 await until('document.querySelector("[data-workspace-chat]")?.dataset.workspaceChat==="102" && document.querySelectorAll("nav[aria-label] button[aria-pressed][aria-label]").length>=3');
 assert.ok(await js('JSON.parse(localStorage.getItem("chatter_workspace:fixture:2")).tools.includes("map")'));
 await js('window.filterWorkspaceChats()');
 await until('window.workspaceChatTitle==="Второй чат"');
 await sleep(250);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-workspace-review.png'),(await wc.capturePage()).toPNG());
 await js('[...document.querySelectorAll("button[aria-label]")].find(button=>button.getAttribute("aria-label")==="Закрыть вкладку «Второй чат»").click()');
 await until('document.querySelector("[data-workspace-chat][aria-current=page]")?.dataset.workspaceChat==="101" && document.activeElement.dataset.workspaceChat==="101"');
 const strip='document.querySelector("[data-workspace-tab-strip]")';
 const arrow=direction=>'[...document.querySelectorAll("button[aria-label]")].find(button=>button.getAttribute("aria-label")==='+JSON.stringify('Прокрутить вкладки '+direction)+')';
 assert.equal(await js('Boolean('+arrow('влево')+')'),false);
 await js('(()=>{const key="chatter_workspace:fixture:2";const state=JSON.parse(localStorage.getItem(key));state.tabs=Array.from({length:24},(_,i)=>({id:200+i,title:"Длинный заголовок разговора "+(i+1),pinned:i===0}));localStorage.setItem(key,JSON.stringify(state));window.testActiveChat=223;window.reloadWorkspace();})()');
 await until(arrow('вправо')+'?.getAttribute("aria-disabled")==="true" && '+strip+'.scrollLeft>0');
 assert.equal(await js('getComputedStyle('+strip+').scrollbarWidth'),'none');
 const fitsActive='(()=>{const strip='+strip+'.getBoundingClientRect(),active=document.querySelector("[data-workspace-chat][aria-current=page]").parentElement.getBoundingClientRect();return active.left>=strip.left-1 && active.right<=strip.right+1;})()';
 assert.equal(await js(fitsActive),true,'an active chat at the far end is revealed together with its actions');
 const end=await js(strip+'.scrollLeft');
 await js(arrow('влево')+'.click()');
 await until(strip+'.scrollLeft<'+end);
 await until(arrow('вправо')+'.getAttribute("aria-disabled")==="false"');
 await js(strip+'.scrollLeft=0');
 await until(arrow('влево')+'.getAttribute("aria-disabled")==="true"');
 const wheel=await js('(()=>{const strip='+strip+';const event=new WheelEvent("wheel",{deltaY:140,bubbles:true,cancelable:true});strip.dispatchEvent(event);return {position:strip.scrollLeft,cancelled:event.defaultPrevented};})()');
 assert.deepEqual(wheel,{position:140,cancelled:true});
 await js(strip+'.scrollLeft=0');
 assert.equal(await js('(()=>{const strip='+strip+';const event=new WheelEvent("wheel",{deltaY:-100,bubbles:true,cancelable:true});strip.dispatchEvent(event);return event.defaultPrevented;})()'),false,'wheel events at the edge remain available to the surrounding UI');
 await js('document.querySelector("[data-workspace-chat][title$=\\\"24\\\"]").click()');
 win.setSize(1000,810);
 await until(fitsActive);
 await sleep(150);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-workspace-scroll-review.png'),(await wc.capturePage()).toPNG());
 console.log('PASS: hidden native scrollbar, overflow arrows, horizontal wheel scrolling and active tab visibility after resize');
 // Exercise Chromium hit testing and real input after a fresh mount with the top preset.
 const target=async expression=>{
  const result=await js('(()=>{const element='+expression+';const r=element.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);return {x,y,receiver:hit?.outerHTML.slice(0,250),hit:element.contains(hit)};})()');
  assert.ok(result.hit,expression+' was blocked '+JSON.stringify(result));
  return {x:result.x,y:result.y};
 };
 const clickAt=async expression=>{
  const point=await target(expression);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...point,type:'mousePressed',button:'left',clickCount:1});
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...point,type:'mouseReleased',button:'left',clickCount:1});
 };
 const wheelAt=async expression=>{
  const point=await target(expression);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',{...point,type:'mouseWheel',deltaX:0,deltaY:360});
 };
 await wc.debugger.attach('1.3');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 for(const width of [740,1450]){
  win.setSize(width,850);
  await js('window.resetWorkspaceTools();window.reloadWorkspace()');
  await until('document.querySelector("#chat-library")?.inert && document.querySelector("#chat-tools-panel")?.inert');
  await clickAt('document.querySelector("button[aria-controls=chat-library]")');
  await until('!document.querySelector("#chat-library").inert && document.activeElement.getAttribute("aria-label")==="Library search" && Math.abs(document.querySelector("#chat-library").getBoundingClientRect().left)<1');
  assert.ok(await js('getComputedStyle(document.querySelector("#chat-library")).transitionProperty.includes("translate")'));
  await wheelAt('document.querySelector("[data-library-scroll]")');
  await until('document.querySelector("[data-library-scroll]").scrollTop>0');
  await clickAt('document.querySelector("[data-library-notifications]")');
  await until('document.querySelector("[data-library-notifications]").getAttribute("aria-pressed")==="true"');
  await clickAt('document.querySelector("[data-library-settings]")');
  await until('!!document.querySelector("#layout-editor-fixture")');
  await js('window.closeLayoutEditor()');
  await until('!document.querySelector("#layout-editor-fixture")');
  await clickAt('document.querySelector("[data-layout-side] > [data-open=true]")');
  await until('document.querySelector("#chat-library").inert && getComputedStyle(document.querySelector("#chat-library")).visibility==="hidden"');
  const notebookButton='[...document.querySelectorAll("button[aria-label]")].find(button=>button.getAttribute("aria-label")==="Блокнот")';
  await clickAt(notebookButton);
  try {
   await until('!document.querySelector("#chat-tools-panel")?.inert && document.querySelector("#chat-tools-panel").getBoundingClientRect().width>=259 && Boolean(window.notebookList()?.scrollHeight>window.notebookList()?.clientHeight)');
  } catch (error) {
   console.error('Notebook panel:',await js('(()=>{const p=document.querySelector("#chat-tools-panel"),l=window.notebookList();return {inert:p.inert,open:p.dataset.toolsPanelOpen,width:p.getBoundingClientRect().width,visibility:getComputedStyle(p).visibility,tool:p.textContent.slice(0,120),listHeight:l?.clientHeight,listScrollHeight:l?.scrollHeight};})()'));
   throw error;
  }
  await wheelAt('window.notebookList()');
  await until('window.notebookList().scrollTop>0');
  const createNote='[...document.querySelectorAll("#chat-tools-panel button")].find(button=>button.textContent.trim()==="Создать")';
  await until('Boolean('+createNote+')');
  await clickAt(createNote);
  await until('!!document.querySelector("#chat-tools-panel textarea")');
  if(width===740){
   await clickAt(notebookButton);
   await until('document.querySelector("#chat-tools-panel").inert && document.querySelector("#chat-tools-panel").getBoundingClientRect().width<1');
   assert.equal(await js('getComputedStyle(document.querySelector("#chat-tools-panel")).position'),'absolute');
  }
 }
 // Return controls must work both in the native conversation and above the library backdrop.
 for(const width of [320,740,1450]){
  win.setSize(width,850);
  await js('window.resetWorkspaceTools();window.reloadWorkspace()');
  await until('document.querySelector("#chat-library")?.inert');
  assert.equal(await js('[...document.querySelectorAll("button")].some(button=>button.textContent.trim()==="Вернуться к своему интерфейсу")'),false);
  const before=await js('window.shellReturnState.activeChatId');
  await js('window.enableShellReturn()');
  const nativeReturn='[...document.querySelectorAll("main button")].find(button=>button.textContent.trim()==="Вернуться к своему интерфейсу")';
  await until('Boolean('+nativeReturn+')');
  await clickAt(nativeReturn);
  await until('window.shellReturnState.open && window.shellReturnState.view==="home"');
  assert.equal(await js('window.shellReturnState.activeChatId'),before);
  await js('window.enableShellReturn()');
  await clickAt('document.querySelector("button[aria-controls=chat-library]")');
  await until('!document.querySelector("#chat-library").inert && Math.abs(document.querySelector("#chat-library").getBoundingClientRect().left)<1');
  await clickAt('[...document.querySelectorAll("#chat-library button")].find(button=>button.textContent.trim()==="Вернуться к своему интерфейсу")');
  await until('document.querySelector("#chat-library").inert && window.shellReturnState.open && window.shellReturnState.view==="home" && !window.shellReturnState.libraryOpen');
  assert.equal(await js('window.shellReturnState.activeChatId'),before);
 }
 console.log('PASS: custom interface return is clickable in the native conversation and chat drawer at narrow/wide widths, closes the drawer and preserves the active chat');
 await wc.debugger.detach();

 const answerSample='document.querySelector("[data-answer-sample]")';
 await js('window.setAnswerSample("reasoning")');
 await until('!!'+answerSample);
 assert.equal(await js('Boolean('+answerSample+'.querySelector("[data-answer-bubble]"))'),false);
 await js('window.setAnswerSample("draft")');
 await until('Boolean('+answerSample+'.querySelector("[data-empty-answer]"))');
 assert.equal(await js('getComputedStyle('+answerSample+'.querySelector("[data-empty-answer]")).display'),'none');
 assert.ok(await js(answerSample+'.querySelector("[data-work-log]").textContent.includes("Partial answer")'));
 await js('window.setAnswerSample("final")');
 await until('Boolean('+answerSample+'.querySelector("[data-answer-bubble]"))');
 assert.equal(await js('getComputedStyle('+answerSample+'.querySelector("[data-answer-bubble]")).paddingTop'),'12px');
 assert.ok(await js(answerSample+'.querySelector("[data-answer-bubble]").textContent.includes("Final answer")'));
 console.log('PASS: thinking and work-log drafts have no answer bubble, final answer has top padding after the work log');
 assert.deepEqual(errors,[]);
 console.log('PASS: real pointer clicks and wheel scrolling in the chat library and Notebook with the persisted top layout');
 console.log('PASS: top workspace preview, mounted library and folder state, Escape/focus, tab pin and close, tool favorites and persistence');
 console.log('PASS: layout editor, in-chat preview, stateful panel reorder, docked composer bottom follow, narrow tools panel, and inactive bot layout save');
 await js('window.openQueueFixture()');
 await until('!!document.querySelector("[data-confirmation-id=first]")');
 await js('window.pickRequest("second")');
 await until('!!document.querySelector("[data-confirmation-id=second]")');
 assert.deepEqual(await js('window.queueCalls'),[],'reviewing a request never approves it');
 await js('window.pickRequest("first")');
 await until('!!document.querySelector("[data-confirmation-id=first]")');
 await js('window.clickText("Approve first")');
 await until('!!window.finishQueueAction');
 await js('window.pickRequest("second")');
 await sleep(50);
 assert.ok(await js('!!document.querySelector("[data-confirmation-id=first]")'),'review waits for a running native action');
 await js('window.finishQueueAction()');
 await until('!!document.querySelector("[data-confirmation-id=second]")');
 assert.deepEqual(await js('window.queueCalls'),['first']);
 await js('window.clickText("Approve second")');
 assert.deepEqual(await js('window.queueCalls'),['first','second']);
 await js('window.enableCustomConfirmations()');
 await until('window.projectedConfirmations?.length===2&&window.projectedConfirmations.every(card=>card.ready)');
 assert.equal(await js('document.querySelectorAll("[data-confirmation-id]").length'),0,'custom cards do not reveal native UI');
 const customCard=await js('window.projectedConfirmations.find(card=>card.id==="first")');
 assert.equal(customCard.fields.length,2);
 assert.ok(JSON.stringify(customCard.content).includes('before source'));
 assert.ok(JSON.stringify(customCard.content).includes('after source'));
 const passwordField=customCard.fields.find(field=>field.type==='password').id,rememberField=customCard.fields.find(field=>field.type==='checkbox').id;
 await js('window.setProjectedField("first",'+JSON.stringify(passwordField)+',"new password")');
 await js('window.setProjectedField("first",'+JSON.stringify(rememberField)+',true)');
 await until('window.projectedConfirmations.find(card=>card.id==="first").fields.some(field=>field.type==="password"&&field.value==="new password")');
 const customApprove=customCard.actions.find(action=>action.label==='Approve first').id;
 assert.equal(await js('window.runProjectedConfirmation("first",'+JSON.stringify(customApprove)+','+customCard.revision+').then(()=>"ran",error=>error.message)'),'confirmation_changed','old action revisions cannot approve changed fields');
 await js('void (window.pendingProjectedAction=window.runProjectedConfirmation("first",'+JSON.stringify(customApprove)+',window.projectedConfirmations.find(card=>card.id==="first").revision))');
 await until('window.projectedConfirmations.find(card=>card.id==="first").busy');
 assert.deepEqual(await js('window.queueLastValues'),{password:'new password',remember:true},'the original handler consumes current custom field values');
 assert.equal(await js('window.runProjectedConfirmation("first",'+JSON.stringify(customApprove)+',window.projectedConfirmations.find(card=>card.id==="first").revision).then(()=>"ran",error=>error.message)'),'confirmation_unavailable');
 await js('window.finishQueueAction();window.pendingProjectedAction');
 await until('!window.projectedConfirmations.find(card=>card.id==="first").busy');
 await js('(()=>{const card=window.projectedConfirmations.find(card=>card.id==="first");return window.runProjectedConfirmation(card.id,card.actions.find(action=>action.comment).id,card.revision,"  Please change the command  ");})()');
 assert.equal(await js('window.queueLastComment'),'Please change the command');
 await js('window.setUnsupportedConfirmation(true)');
 await until('window.projectedConfirmations.some(card=>!card.customizable)&&document.querySelectorAll("[data-confirmation-id]").length>0');
 assert.deepEqual(errors,[]);
 console.log('PASS: full custom confirmation projection, fields/diff data, native callback reuse, comments, stale/busy guards and unsupported-content fallback');
 console.log('PASS: requested native confirmation selection, wrapped card IDs, busy-action protection and no automatic approval');
 win.destroy();
 console.log('PASS: actual appearance editor and cards, inactive saves, reversible preview, palette/typography/density, virtual height restoration, applying proposals from recovery bar, arrival-only animation, reduced motion and app-wide themes across account changes/logout');
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
`;
try {
  await build({
    configFile: false,
    root: desktopRoot,
    logLevel: 'error',
    plugins: [
      {
        name: 'appearance-ui-fixture',
        enforce: 'pre',
        resolveId(id: string, importer?: string) {
          if (id === 'test-auth' || id.endsWith('/lib/auth') || id === './auth')
            return '\0test-auth';
          if (
            (id.endsWith('/lib/api') || id === './api') &&
            /AppearancePanel|AppearanceController|appearance-service|chat-layout-service|NotebookTool/.test(importer ?? '')
          )
            return '\0test-api';
          if (['./ToolContent', './FloatingWidget'].includes(id) && importer?.endsWith('ToolsPanel.tsx')) return '\0layout-fixture-tools';
          if (id === 'appearance-ui.tsx') return '\0' + id;
        },
        async load(id: string) {
          if (id === '\0layout-fixture-tools') return `import { createElement } from 'react';
            import { NotebookTool } from ${modulePath('components/NotebookTool.tsx')};
            export const ToolContent = ({toolId, contentMax}) => toolId === 'notebook' ? createElement(NotebookTool, {contentMax}) : null;
            export const FloatingWidget = () => null;`;
          if (id === '\0test-auth')
            return transformWithEsbuild(authModule, 'auth.tsx', {
              loader: 'tsx',
              jsx: 'automatic',
            });
          if (id === '\0test-api')
            return transformWithEsbuild(apiModule, 'api.ts', { loader: 'ts' });
          if (id === '\0appearance-ui.tsx')
            return transformWithEsbuild(fixture, 'fixture.tsx', {
              loader: 'tsx',
              jsx: 'automatic',
            });
        },
      },
    ],
    css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
    build: {
      outDir: path.join(directory, 'renderer'),
      rollupOptions: {
        input: 'appearance-ui.tsx',
        output: { entryFileNames: 'entry.js' },
        onwarn(warning: { code?: string }, warn: (warning: unknown) => void) {
          if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
        },
      },
    },
  });
  const css = fs
    .readdirSync(path.join(directory, 'renderer/assets'))
    .find((name) => name.startsWith('_appearance-ui') && name.endsWith('.css'));
  assert.ok(css);
  fs.writeFileSync(
    path.join(directory, 'renderer/index.html'),
    '<meta charset="UTF-8"><link rel="stylesheet" href="./assets/' +
      css +
      '"><style>#root{height:100%;display:flex;font-size:14px;line-height:1.6}</style>' +
      '<div id="root"></div><script type="module" src="./entry.js"></script>',
  );
  fs.writeFileSync(path.join(directory, 'main.cjs'), electronFixture);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopRequire('electron'), [path.join(directory, 'main.cjs')], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Appearance UI fixture timed out'));
    }, 65000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  process.stdout.write(output);
  assert.equal(code, 0);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('chatter-appearance-ui-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
