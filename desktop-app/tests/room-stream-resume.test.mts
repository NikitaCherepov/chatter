import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('../node_modules/typescript');
const { RoomStreamBuffer } = require('../src/renderer/lib/room-stream-buffer.ts');
const { ChatStreamBuffer } = require('../../backend-api/src/services/chat-stream-buffer.ts');
// Exercise the actual page effect/handler with controllable HTTP timing, no model calls.
const page = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.tsx', import.meta.url),'utf8').replace(/\r\n/g,'\n');
const restoreStart = page.indexOf('  const restoreRoomStream =');
const effectEnd = page.indexOf('  }, [activeChatId, messageCache]);',restoreStart) + '  }, [activeChatId, messageCache]);'.length;
const handlerMarker = page.indexOf('return api.onRoomEvent((event) =>');
const handlerStart = page.lastIndexOf('  useEffect(() => {',handlerMarker);
const handlerEnd = page.indexOf('\n\n  const handleSend',handlerStart);
assert.ok(restoreStart>0 && effectEnd>restoreStart && handlerStart>0 && handlerEnd>handlerStart);
const code = ts.transpileModule('(()=>{'+page.slice(restoreStart,effectEnd)+page.slice(handlerStart,handlerEnd)+'})()', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const ref = (current:any) => ({current});
let cleanups:Array<()=>void> = [], onEvent:any, onConnect:any, state:any, saved:any[] = [], status:any, load:any;
const no = () => {};
const context:any = {
  RoomStreamBuffer, activeChatId:1, activeChatIdRef:ref(1), user:{id:1},
  messageCache:{receiveVariants:no, changed:no, accept:no}, variantSwitchBusyRef:ref(false),
  roomStreamBuffersRef:ref(new Map()), roomStreamRevisionRef:ref(new Map()), roomStreamChatIdsRef:ref(new Set()),
  roomEventAgentMsgIds:ref(new Map()), pendingUserMessageIdByChatRef:ref(new Map()), regeneratingMessageRef:ref(null),prevMsgCountRef:ref(0),
  notifyAssistantResponse:no,refreshContextTokens:no,t:(s:string)=>s,clearSendWatchdog:no,applyAvatarState:no,promoteChat:no,markAsRead:no,incrementUnread:no,
  setMessages:(update:any)=>{state.messages=typeof update==='function'?update(state.messages):update;},
  setSending:(v:any)=>{state.sending=v;},setShowTyping:(v:any)=>{state.typing=v;},setTypingIdentity:no,
  setStreamingState:(v:any)=>{state.phase=typeof v==='function'?v(state.phase):v;},setStreamingMsgId:(v:any)=>{state.streamId=v;},
  toast:{error:no,info:no},
  loadMessages:async (id:number,valid=()=>true)=>{const rows=await load(id);if(valid()&&context.activeChatIdRef.current===id)state.messages=rows;},
  api:{isNewspaperChat:()=>false,getRoomStreamStatus:async()=>await status(),
    onWebSocketConnect:(fn:any)=>{onConnect=fn;return no;},onRoomEvent:(fn:any)=>{onEvent=fn;return no;}},
  useEffect:(fn:any)=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);}, Date, console,
};
vm.createContext(context);
const tick = async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const mount = (id:number)=>{for(const cleanup of cleanups)cleanup();cleanups=[];context.activeChatId=id;context.activeChatIdRef.current=id;vm.runInContext(code,context);};
const emit=(event:any)=>onEvent({...event,chat_id:1});
const start={type:'chat_agent_start',chat_id:1,agent_id:null,prompt_name:'Bot'};
state={messages:[],sending:false}; load=async()=>saved.slice(); status=async()=>({active:false,stream:null});
mount(1); await tick();
const server=new ChatStreamBuffer(start); emit(server.snapshot());emit(server.event({type:'chat_agent_token',text:'Hello'}));
mount(2); await tick(); emit(server.event({type:'chat_agent_token',text:' world'})); emit(server.event({type:'chat_agent_reasoning',text:'Reason'}));
assert.equal(state.messages.length,0,'background chat must not leak into the open chat');
let resolveStatus:any;const snapshot=server.snapshot();status=()=>new Promise(resolve=>{resolveStatus=resolve;});
mount(1);await tick();assert.equal(state.messages[0].content,'Hello world','return restores cached text before HTTP completes');
const next=server.event({type:'chat_agent_token',text:'!'});emit(next);resolveStatus({active:true,stream:snapshot});await tick();emit(next);
assert.equal(state.messages.length,1);assert.equal(state.messages[0].content,'Hello world!');assert.equal(state.messages[0].reasoning_content,'Reason');
assert.equal(state.sending,true);assert.equal(state.streamId,state.messages[0].id);
// A completed response must not be resurrected by an older status response.
onConnect();await tick();const stale=server.snapshot();
emit(server.event({type:'chat_agent_done',owner_user_id:1,result:{message_id:77,reply_text:'Finished'}}));emit({type:'chat_queue_done'});
resolveStatus({active:true,stream:stale});await tick();assert.equal(state.messages[0].id,77);assert.equal(state.sending,false);
// Late join after losing start and early tokens, with a newer token before status arrives.
context.roomStreamBuffersRef.current.clear();context.roomEventAgentMsgIds.current.clear();
const lateServer=new ChatStreamBuffer({...start,regenerate_message_id:77});lateServer.event({type:'chat_agent_token',text:'Replacement'});
saved=[{id:77,role:'assistant',content:'Old'}];mount(2);await tick();mount(1);await tick();
emit(lateServer.event({type:'chat_agent_token',text:' answer'}));resolveStatus({active:true,stream:lateServer.snapshot()});await tick();
assert.equal(state.messages.length,1);assert.equal(state.messages[0].content,'Replacement answer');assert.ok(state.messages[0].id<0);
// Completion during a slow history fetch: fetch persisted history again, not the old partial bubble.
let resolveLoad:any;load=()=>new Promise(resolve=>{resolveLoad=resolve;});mount(2);mount(1);
saved=[{id:88,role:'assistant',content:'Persisted'}];emit(lateServer.event({type:'chat_agent_done',owner_user_id:1,result:{message_id:88,reply_text:'Persisted'}}));emit({type:'chat_queue_done'});
load=async()=>saved.slice();status=async()=>({active:false,stream:null});resolveLoad([]);await tick();
assert.equal(state.messages.length,1);assert.equal(state.messages[0].id,88);assert.equal(state.sending,false);
for(const cleanup of cleanups)cleanup();
console.log('PASS: actual ChatPage switching, background text, racing status/tokens, completion during status/history, late join, reconnect and regeneration');
