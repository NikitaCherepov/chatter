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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-recovery-'));
const shell = JSON.stringify(
  path.join(desktop, 'src/renderer/components/AppearanceShell.tsx').replaceAll('\\', '/'),
);
const rendererFile = (file: string) =>
  JSON.stringify(path.join(desktop, 'src/renderer/lib', file).replaceAll('\\', '/'));
fs.writeFileSync(
  path.join(directory, 'index.html'),
  '<div id="root"></div><script type="module" src="/app.tsx"></script>',
);
fs.writeFileSync(
  path.join(directory, 'app.tsx'),
  `
import React from 'react';import {createRoot} from 'react-dom/client';import {AppearanceShell} from ${shell};
import i18n from 'i18next';import {initReactI18next} from 'react-i18next';
import translations from ${JSON.stringify(path.join(desktop, 'src/renderer/i18n/locales/ru/translation.json').replaceAll('\\', '/'))};
i18n.use(initReactI18next).init({lng:'ru',resources:{ru:{translation:translations}},interpolation:{escapeValue:false},initImmediate:false});
import {previewAppearance,getAppearancePreviewError,setAppearancePreviewError} from ${rendererFile('appearance-runtime.ts')};
import {newAppearance} from ${rendererFile('appearance-schema.ts')};
previewAppearance(newAppearance('fixture'));
window.getPreviewError=getAppearancePreviewError;window.clearValidationError=()=>setAppearancePreviewError('');
window.failures=[];window.actions=[];
Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{if(window.failCopy)throw Error('copy fixture');window.copiedError=value;}}});
function App(){const [code,setCode]=React.useState("import React from 'react';import {useChatterState} from '@chatter/ui';export default function App(){const state=useChatterState();return <button id='working'>A {state?.query}</button>}");
const [shell,setShell]=React.useState(null),[visible,setVisible]=React.useState(true),[query,setQuery]=React.useState('latest'),[version,setVersion]=React.useState(0);
React.useEffect(()=>setShell({version:1,language:'tsx',scope:'workspace',entry:'App.tsx',files:{'App.tsx':code}}),[code]);
window.setCode=setCode;window.setVisible=setVisible;window.setQuery=setQuery;window.refreshShell=()=>setShell(value=>({...value,files:{...value.files}}));
window.replaceInitial=value=>{setShell({version:1,language:'tsx',scope:'workspace',entry:'App.tsx',files:{'App.tsx':value}});setVersion(n=>n+1);setVisible(true);};
return <div style={{position:'absolute',inset:'40px 0 0'}}>{shell&&<AppearanceShell key={version} theme={{id:'fixture-theme',name:'Jarvis fixture',revision:1}} shell={shell} visible={visible} state={{scopeId:'fixture',chats:[],sections:[],messages:[],activeChatId:1,view:'conversation',query,confirmations:[]}}
onAction={action=>window.actions.push(action)} onClose={()=>setVisible(false)} onRetry={()=>setVisible(true)} onFailure={retained=>{window.failures.push(!!retained);if(!retained)setVisible(false)}}/>}<span id="host-alive">Host works</span></div>;}
createRoot(document.getElementById('root')).render(<App/>);
`,
);
fs.writeFileSync(
  path.join(directory, 'preload.cjs'),
  `
const {contextBridge,ipcRenderer}=require('electron');
const listen=(channel,callback)=>{const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener)};
contextBridge.exposeInMainWorld('electronAPI',{
interactiveCreate:input=>ipcRenderer.invoke('fixture:create',input),interactivePlace:value=>ipcRenderer.invoke('fixture:place',value),interactiveStop:id=>ipcRenderer.invoke('fixture:stop',id),appearanceShellState:(id,state)=>ipcRenderer.invoke('fixture:state',id,state),
onInteractiveStatus:callback=>listen('interactive-preview:status',callback),onAppearanceShellAction:callback=>listen('interactive-preview:appearance-action',callback),
onAppearanceImageRequest:()=>()=>{},onAppearanceDocumentRequest:()=>()=>{}
});
`,
);
fs.writeFileSync(
  path.join(directory, 'main.cjs'),
  `
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const {InteractivePreviews}=require(${JSON.stringify(path.join(desktop, 'dist/main/interactive-preview.js').replaceAll('\\', '/'))});
const {INTERACTIVE_SCHEME}=require(${JSON.stringify(path.join(desktop, 'dist/main/interactive-document.js').replaceAll('\\', '/'))});
protocol.registerSchemesAsPrivileged([{scheme:INTERACTIVE_SCHEME,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',path.join(__dirname,'user-data'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const start=Date.now();while(!await check()){if(Date.now()-start>15000)throw Error('Recovery fixture timed out');await sleep(30)}}
let host,manager;const statuses=[];let creates=0;
app.whenReady().then(async()=>{
host=new BrowserWindow({show:false,opacity:0,skipTaskbar:true,width:1000,height:750,webPreferences:{sandbox:true,contextIsolation:true,preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
manager=new InteractivePreviews();host.webContents.on('console-message',(_event,level,message)=>{if(level>=2&&!message.includes('Security Warning'))console.error('host:',message)});
ipcMain.handle('fixture:create',(event,input)=>{creates++;return manager.create(event.sender,input)});ipcMain.handle('fixture:stop',(event,id)=>manager.stop(event.sender,id));ipcMain.handle('fixture:place',(event,payload)=>manager.place(event.sender,payload));ipcMain.handle('fixture:state',(event,id,state)=>manager.updateAppearanceState(event.sender,id,state));
const send=host.webContents.send.bind(host.webContents);host.webContents.send=(channel,value)=>{if(channel==='interactive-preview:status')statuses.push(value);send(channel,value)};
await host.loadFile(path.join(__dirname,'dist/index.html'));host.showInactive();
const js=code=>host.webContents.executeJavaScript(code),entries=()=>[...manager.entries.values()],active=()=>entries().find(entry=>entry.visible&&entry.ready);
await until(()=>active());const first=active();
await until(async()=>await first.view.webContents.executeJavaScript('document.querySelector("#working")?.textContent')==='A latest');
await js('window.setCode('+JSON.stringify('import React from "react";export default function Broken(){throw new Error("broken draft fixture")}')+')');
await until(async()=>await js('window.failures.includes(true)'));
assert.equal(active().id,first.id,'a broken replacement leaves the running theme untouched');assert.equal(await js('window.failures.includes(false)'),false);
assert.ok(await js('window.getPreviewError()'));await js('window.clearValidationError()');assert.ok(await js('window.getPreviewError()'),'filesystem validation cannot clear a runtime failure');
assert.ok(statuses.some(status=>status.reason==='render'&&status.detail.includes('broken draft fixture')));
await until(()=>js('!!document.querySelector("[data-appearance-failure]")'));
const report=JSON.parse(await js('document.querySelector("[data-appearance-failure-details]").textContent'));
assert.equal(report.phase,'startup');assert.equal(report.reason,'render');assert.equal(report.previousVersionRetained,true);assert.equal(report.theme.id,'fixture-theme');assert.ok(report.stack.includes('appearance/App.tsx'));
await js('document.querySelector("[data-appearance-failure] summary").click();document.querySelector("[data-appearance-failure-copy]").click()');await until(()=>js('!!window.copiedError'));
assert.deepEqual(JSON.parse(await js('window.copiedError')),report);
const before=creates;await js('window.refreshShell()');await sleep(200);assert.equal(creates,before,'unchanged source does not restart or retry a rejected update');
const good='import React from "react";import {useChatterState} from "@chatter/ui";export default function App(){const state=useChatterState();return <button id="working">B {state?.query}</button>}';
await js('window.setCode('+JSON.stringify(good)+')');
await until(()=>active()?.id!==first.id&&active());const second=active();
await until(()=>entries().length===1);await until(async()=>await second.view.webContents.executeJavaScript('document.querySelector("#working")?.textContent')==='B latest');
assert.equal(await js('window.getPreviewError()'),'');
assert.equal(await js('document.querySelector("[data-appearance-failure]")'),null);
await second.view.webContents.executeJavaScript('void Promise.reject(new Error("nonfatal fixture"))');await sleep(150);
assert.equal(active().id,second.id,'a rejected task does not discard a mounted UI');
await second.view.webContents.executeJavaScript('document.querySelector("#working").onclick=()=>{throw new Error("handler fixture")};document.querySelector("#working").click()').catch(()=>{});await sleep(120);assert.equal(active().id,second.id);
await js('window.setQuery("after crash")');await sleep(60);second.view.webContents.forcefullyCrashRenderer();
await until(()=>active()?.id!==second.id&&active());const recovered=active();
await until(async()=>await recovered.view.webContents.executeJavaScript('document.querySelector("#working")?.textContent')==='B after crash');
assert.equal(await js('window.failures.includes(false)'),false,'first crash is recovered without switching to native');
assert.ok(statuses.some(status=>status.reason==='renderer-gone'));
recovered.view.webContents.forcefullyCrashRenderer();await until(async()=>await js('window.failures.includes(false)'));
await until(()=>js('!!document.querySelector("[data-appearance-failure]")'));
const crashReport=JSON.parse(await js('document.querySelector("[data-appearance-failure-details]").textContent'));
assert.equal(crashReport.phase,'runtime');assert.equal(crashReport.reason,'renderer-gone');assert.ok(crashReport.message.includes('exitCode'));
assert.equal(await js('getComputedStyle(document.querySelector("[data-appearance-failure]")).position'),'fixed');
await js('document.querySelector("[data-appearance-failure-retry]").click()');await until(()=>active());await until(()=>js('!document.querySelector("[data-appearance-failure]")'));
await js('window.replaceInitial('+JSON.stringify('import React from "react";export default function Broken(){throw new Error("startup fixture: missing component")}')+')');
await until(()=>js('!!document.querySelector("[data-appearance-failure]") && !document.querySelector("[data-appearance-failure-retry]").disabled'));
assert.equal(JSON.parse(await js('document.querySelector("[data-appearance-failure-details]").textContent')).previousVersionRetained,false);
assert.equal(await js('document.querySelector("[data-appearance-failure] strong").textContent'),'Не удалось запустить тему');
await js('window.failCopy=true;document.querySelector("[data-appearance-failure] summary").click();document.querySelector("[data-appearance-failure-copy]").click()');await until(()=>js('document.querySelector("[data-appearance-failure]").textContent.includes("Не удалось скопировать")'));
await sleep(80);fs.writeFileSync(path.join(__dirname,'error.png'),(await host.webContents.capturePage()).toPNG());
assert.equal(await js('document.querySelector("#host-alive").textContent'),'Host works');
console.log('PASS: real theme recovery, persistent localized startup/update/crash diagnostics, stack and process exit details, explicit error-copy without OS clipboard writes, copy-error fallback and manual retry');
}).catch(error=>{console.error(error,statuses);process.exitCode=1}).finally(()=>{manager?.destroy();host?.destroy();app.exit(process.exitCode??0)});
`,
);
try {
  await build({
    base: './',
    root: directory,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: path.join(desktop, 'node_modules/react'),
        'react-dom': path.join(desktop, 'node_modules/react-dom'),
        'react-i18next': path.join(desktop, 'node_modules/react-i18next'),
        i18next: path.join(desktop, 'node_modules/i18next'),
      },
    },
    build: { outDir: path.join(directory, 'dist'), emptyOutDir: true },
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
    const timeout = setTimeout(() => {
      output += '\nRecovery UI timeout';
      child.kill();
    }, 60000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.once('error', reject);
  });
  process.stdout.write(output);
  assert.equal(code, 0);
  if (fs.existsSync(path.join(directory, 'error.png')))
    fs.copyFileSync(
      path.join(directory, 'error.png'),
      path.join(os.tmpdir(), 'chatter-appearance-error-preview.png'),
    );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
