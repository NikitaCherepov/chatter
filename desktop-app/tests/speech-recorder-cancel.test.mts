import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
let listeners: Record<string, (...args:any[])=>void> = {};
Module._load = function(name:string,...args:any[]) {
  if(name==='hark') return () => ({ on: (name:string, fn:any) => {listeners[name]=fn;}, stop:()=>{} });
  return originalLoad.call(this,name,...args);
};
const { createSpeechRecorder } = require('../src/renderer/lib/speechRecorder.ts');
Module._load = originalLoad;
const devices = { getUserMedia: async () => stream };
Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:devices},configurable:true});
let stoppedTracks=0;
const stream = {getTracks:()=>[{stop:()=>{stoppedTracks++;}}]};
let created=0;
let current:any;
class FakeRecorder {
  static isTypeSupported(){return true;}
  state='inactive';onstop:any;ondataavailable:any;
  constructor(){created++;current=this;}
  start(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['audio'])});void this.onstop?.();});}
}
Object.defineProperty(globalThis,'MediaRecorder',{value:FakeRecorder,configurable:true});
let ended=0,noSpeech=0;
const recorder=createSpeechRecorder({onSpeechEnd:()=>{ended++;},onNoSpeech:()=>{noSpeech++;}});
await recorder.start();
listeners.speaking();
recorder.stop();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(ended,0,'cancellation must not transcribe recorded speech');
assert.equal(noSpeech,0,'cancellation must not invoke no-speech callbacks');
assert.equal(recorder.isActive(),false);
assert.equal(stoppedTracks,1);
const normal=createSpeechRecorder({onSpeechEnd:()=>{ended++;}});
await normal.start();listeners.speaking();current.stop();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(ended,1,'normal completed speech must still be delivered');
normal.stop();
let resolvePermission:any;
devices.getUserMedia=()=>new Promise(resolve=>{resolvePermission=resolve;});
const beforeCreated=created;
const pending=createSpeechRecorder({onSpeechEnd:()=>{ended++;}});
const starting=pending.start();pending.stop();resolvePermission(stream);await starting;
assert.equal(created,beforeCreated,'late permission must not start a cancelled recorder');
assert.equal(pending.isActive(),false);
assert.equal(stoppedTracks,3,'late microphone stream must be released');
console.log('Speech recorder: cancellation discards audio, normal completion works, and late microphone permission is released.');
