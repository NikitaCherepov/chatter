import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esbuild = require('../../desktop-app/node_modules/esbuild');
// Bundle the real runner, replacing only model/identity dependencies. No network or database.
const built = await esbuild.build({entryPoints:[new URL('../src/services/chat-runner.ts',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'model-stub',setup(build:any){
  build.onResolve({filter:/^\.\/(ai|chats|chat-rooms|prompts)\.js$/},(args:any)=>({path:args.path,namespace:'stub'}));
  build.onLoad({filter:/.*/,namespace:'stub'},(args:any)=>({contents:args.path==='./ai.js'?'export const sendMessageThroughAi=(...args)=>globalThis.sendAi(...args)':args.path==='./chats.js'?'export const getUserById=()=>null;export const resolvePromptForChat=()=>null':args.path==='./chat-rooms.js'?'export const getChatAgentForResponse=()=>({source_prompt_id:1,name:"Bot"})':'export const getUserPromptImageBySelectedId=()=>null'}));
}}]});
const calls:any[] = [], events:any[] = [], logs:any[]=[];
const context:any={module:{exports:{}},exports:{},require,AbortController,console:{log:()=>{},warn:()=>{},error:(...v:any[])=>logs.push(v)},
  sendAi:(_owner:any,_prompt:any,_chat:any,options:any)=>new Promise((resolve,reject)=>{calls.push({options,resolve,reject});}),};
context.exports=context.module.exports;vm.createContext(context);vm.runInContext(built.outputFiles[0].text,context);
const {runChatSteps,getChatRunStatus,stopChatRun}=context.module.exports;
const step={kind:'default',ownerUserId:1,initiatorUserId:1,prompt:'Test'};
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const first=runChatSteps(12,[step],(e:any)=>events.push(e));
assert.equal(getChatRunStatus(12).active,true);assert.equal(getChatRunStatus(13).stream,null);
await calls[0].options.onStreamToken('Text');await calls[0].options.onReasoningStream('Reason');
const snapshot=getChatRunStatus(12).stream;assert.equal(snapshot.content,'Text');assert.equal(snapshot.reasoning_content,'Reason');assert.equal(snapshot.sequence,2);
const second=runChatSteps(12,[{...step,options:{regenerateMessageId:70}}],(e:any)=>events.push(e));
assert.equal(calls.length,1,'queued run must not replace current buffer');
calls[0].resolve({message_id:70});await first;await tick();
const replacement=getChatRunStatus(12).stream;
assert.notEqual(replacement.stream_id,snapshot.stream_id);assert.equal(replacement.content,'');assert.equal(replacement.regenerate_message_id,70);
await calls[1].options.onStreamToken('New');assert.equal(snapshot.content,'Text');
calls[1].resolve({message_id:70});await second;await tick();
assert.equal(getChatRunStatus(12).active,false);assert.equal(getChatRunStatus(12).stream,null);
const failed=runChatSteps(13,[step],(e:any)=>events.push(e));calls[2].reject(new Error('Test failure'));await failed;await tick();
assert.equal(getChatRunStatus(13).stream,null);assert.equal(getChatRunStatus(13).active,false);
const aborted=runChatSteps(14,[step],(e:any)=>events.push(e));await calls[3].options.onStreamToken('Partial');assert.equal(stopChatRun(14),true);
assert.equal(calls[3].options.externalAbortSignal.aborted,true);calls[3].resolve({aborted:true,message_id:90});await aborted;await tick();assert.equal(getChatRunStatus(14).stream,null);
assert.ok(events.some((e:any)=>e.type==='chat_agent_token'&&e.sequence===1&&e.stream_id));
console.log('PASS: actual runner status, text/reasoning, queue isolation, regeneration, completion/error/abort cleanup');
