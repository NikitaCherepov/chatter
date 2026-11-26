import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  require = createRequire(import.meta.url),
  { build } = require('vite');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-audio-ui-'));
const source = (file: string) => JSON.stringify(path.join(desktop, file).replaceAll('\\', '/'));
fs.writeFileSync(
  path.join(directory, 'index.html'),
  '<div id="root"></div><script type="module" src="/host.tsx"></script>',
);
fs.writeFileSync(
  path.join(directory, 'host.tsx'),
  `
import React from 'react';import {createRoot} from 'react-dom/client';
import {AppearanceShell} from ${source('src/renderer/components/AppearanceShell.tsx')};
import {useThemeEffectsBridge} from ${source('src/renderer/lib/use-theme-effects.ts')};
import {setThemeEffectsPreferences} from ${source('src/renderer/lib/theme-effects-preferences.ts')};
window.started=0;window.commands=[];window.failures=[];
const NativeContext=window.AudioContext;
window.AudioContext=class extends NativeContext{constructor(...args){super(...args);window.audioContext=this;const create=this.createBufferSource.bind(this);this.createBufferSource=()=>{const node=create(),start=node.start.bind(node);node.start=(...args)=>{window.started++;window.duration=node.buffer?.duration;return start(...args)};return node;};}};
setThemeEffectsPreferences({soundEnabled:false,soundVolume:.35});
function App({shell}){const audio=useThemeEffectsBridge('audio-fixture',shell.assets,false);window.audioState=audio.audio;window.audioPreferences=audio.preferences;
return <div style={{position:'absolute',inset:'40px 0 0'}}><AppearanceShell shell={shell} visible={true} onVisibility={audio.setVisible}
state={{scopeId:'audio-fixture',chats:[],sections:[],messages:[],view:'home',activeChatId:null,themeEffects:audio.preferences,themeAudio:audio.audio}}
onAction={action=>{window.commands.push(action);audio.handle(action)}} onClose={()=>{}} onFailure={failure=>window.failures.push(failure)}/></div>;}
window.renderTheme=shell=>createRoot(document.getElementById('root')).render(<App shell={shell}/>);window.ready=true;
`,
);
fs.writeFileSync(
  path.join(directory, 'preload.cjs'),
  `
const {contextBridge,ipcRenderer}=require('electron');
const listen=(name,callback)=>{const listener=(_event,value)=>callback(value);ipcRenderer.on(name,listener);return()=>ipcRenderer.removeListener(name,listener)};
contextBridge.exposeInMainWorld('electronAPI',{
localAppearance:payload=>ipcRenderer.invoke('themes:manage',payload),interactiveCreate:input=>ipcRenderer.invoke('fixture:create',input),interactivePlace:value=>ipcRenderer.invoke('fixture:place',value),interactiveStop:id=>ipcRenderer.invoke('fixture:stop',id),appearanceShellState:(id,state)=>ipcRenderer.invoke('fixture:state',id,state),
onInteractiveStatus:callback=>listen('interactive-preview:status',callback),onAppearanceShellAction:callback=>listen('interactive-preview:appearance-action',callback),onAppearanceImageRequest:()=>()=>{},onAppearanceDocumentRequest:()=>()=>{}
});
`,
);
fs.writeFileSync(
  path.join(directory, 'main.cjs'),
  `
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{app,BrowserWindow,protocol,ipcMain}=require('electron');
const {InteractivePreviews}=require(${source('dist/main/interactive-preview.js')});const {INTERACTIVE_SCHEME}=require(${source('dist/main/interactive-document.js')});
protocol.registerSchemesAsPrivileged([{scheme:INTERACTIVE_SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',path.join(__dirname,'user-data'));const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const start=Date.now();while(!await check()){if(Date.now()-start>10000)throw Error('Audio UI timeout');await sleep(30)}}
let host,manager;const statuses=[];
app.whenReady().then(async()=>{
const samples=2400,rate=8000,wav=Buffer.alloc(44+samples*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*5000),44+i*2);
const url='chatter-theme://'+'a'.repeat(24)+'/'+crypto.createHash('sha256').update(wav).digest('hex')+'.wav';
host=new BrowserWindow({show:false,opacity:0,skipTaskbar:true,width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
host.webContents.setAudioMuted(true); // Exercise the real audio graph without sound in the user's speakers.
manager=new InteractivePreviews(undefined,(_owner,asset)=>{assert.equal(asset,url);return {data:wav,mimeType:'audio/wav'}});
ipcMain.handle('fixture:create',(event,input)=>manager.create(event.sender,input));ipcMain.handle('fixture:place',(event,input)=>manager.place(event.sender,input));ipcMain.handle('fixture:stop',(event,id)=>manager.stop(event.sender,id));ipcMain.handle('fixture:state',(event,id,state)=>manager.updateAppearanceState(event.sender,id,state));
ipcMain.handle('themes:manage',(_event,payload)=>{assert.equal(payload.action,'asset');assert.equal(payload.url,url);return {data:new Uint8Array(wav).buffer,mimeType:'audio/wav'}});
const original=host.webContents.send.bind(host.webContents);host.webContents.send=(channel,value)=>{if(channel==='interactive-preview:status')statuses.push(value);original(channel,value)};
await host.loadFile(path.join(__dirname,'dist/index.html'));host.showInactive();const js=code=>host.webContents.executeJavaScript(code);await until(()=>js('!!window.ready'));
const code="import React from 'react';import {useThemeAudio} from '@chatter/ui';export default function App(){const audio=useThemeAudio();return <><button id='enable' onClick={()=>audio.setPreferences({soundEnabled:true})}>Enable</button><button id='play' onClick={()=>audio.play('assets/click.wav')}>Play</button><output id='enabled'>{String(audio.soundEnabled)}</output></>}";
await js('window.renderTheme('+JSON.stringify({version:1,language:'tsx',scope:'workspace',entry:'App.tsx',files:{'App.tsx':code},assets:{'assets/click.wav':url}})+')');
await until(()=>[...manager.entries.values()].some(entry=>entry.ready&&entry.visible));await sleep(100);const entry=[...manager.entries.values()].find(entry=>entry.ready),view=entry.view.webContents;
const ready=statuses.findLast(status=>status.id===entry.id&&status.phase==='ready');assert.equal(ready.visible,true,'ready must carry current visibility even if a load-time notification was suppressed');
await view.executeJavaScript('document.querySelector("#enable").click()',true);await until(()=>view.executeJavaScript('document.querySelector("#enabled").textContent==="true"'));
await view.executeJavaScript('document.querySelector("#play").click()',true);await until(()=>js('window.started===1'));
assert.equal(await js('window.audioState.error'),null);assert.equal(await js('window.audioContext.state'),'running');assert.ok((await js('window.duration'))>.25);
host.hide();await until(()=>statuses.some(status=>status.id===entry.id&&status.visible===false));await sleep(80);
await view.executeJavaScript('document.querySelector("#play").click()',true);await sleep(100);assert.equal(await js('window.started'),1,'hidden themes remain silent');
host.showInactive();await until(()=>statuses.findLast(status=>status.id===entry.id)?.visible===true);await sleep(80);await view.executeJavaScript('document.querySelector("#play").click()',true);await until(()=>js('window.started===2'));
console.log('PASS: real AppearanceShell/useThemeEffectsBridge audio startup, enable gesture, IPC asset bytes, Web Audio decode/source start and hide/show gating; no user preferences or speakers touched');
}).catch(error=>{console.error(error,statuses);process.exitCode=1}).finally(()=>{manager?.destroy();host?.destroy();app.exit(process.exitCode??0)});
`,
);
try {
  await build({
    root: directory,
    base: './',
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: path.join(desktop, 'node_modules/react'),
        'react-dom': path.join(desktop, 'node_modules/react-dom'),
        'react-i18next': path.join(desktop, 'node_modules/react-i18next'),
      },
    },
    build: { outDir: path.join(directory, 'dist') },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], {
    env,
    cwd: desktop,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      output += '\nAudio UI test timeout';
      child.kill();
    }, 45000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', reject);
  });
  process.stdout.write(output);
  assert.equal(code, 0);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
