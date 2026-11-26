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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-storage-ui-'));
const theme = `import React from 'react';import {useThemeStorage} from '@chatter/ui';
function Reader(){const [value]=useThemeStorage('count',0);return <output id="second">{value}</output>}
export default function App(){const [count,setCount,storage]=useThemeStorage('count',0);window.flushStorage=storage.flush;
return <main style={{padding:60}}><output id="count">{storage.ready?count:'loading'}</output><Reader/>
<button id="add" onClick={()=>setCount(value=>value+1)}>Add</button><button id="reset" onClick={storage.reset}>Reset</button>
<output id="error">{storage.error}</output><output id="dirty">{String(storage.dirty)}</output></main>}`;
fs.writeFileSync(
  path.join(directory, 'index.html'),
  '<div id="root"></div><script type="module" src="/app.tsx"></script>',
);
fs.writeFileSync(
  path.join(directory, 'app.tsx'),
  `
import React from 'react';import {createRoot} from 'react-dom/client';import {AppearanceShell} from ${JSON.stringify(path.join(desktop, 'src/renderer/components/AppearanceShell.tsx').replaceAll('\\', '/'))};
const shell={version:1,scope:'workspace',language:'tsx',entry:'App.tsx',files:{'App.tsx':${JSON.stringify(theme)}}};
function App(){const [id,setId]=React.useState('alpha'),[version,setVersion]=React.useState(0);window.setThemeId=setId;window.restartTheme=()=>setVersion(n=>n+1);
return <div style={{position:'absolute',inset:'40px 0 0'}}><AppearanceShell key={version} theme={{id,name:id,revision:1}} shell={shell} visible={true}
state={{scopeId:'fixture',chats:[],folders:[],sections:[],messages:[],view:'home',activeChatId:null,confirmations:[]}}
onAction={()=>{}} onClose={()=>{}} onFailure={()=>{window.themeFailed=true}}/></div>};createRoot(document.getElementById('root')).render(<App/>);`,
);
fs.writeFileSync(
  path.join(directory, 'preload.cjs'),
  `
const {contextBridge,ipcRenderer}=require('electron');const listen=(channel,cb)=>{const fn=(_event,value)=>cb(value);ipcRenderer.on(channel,fn);return()=>ipcRenderer.removeListener(channel,fn)};
contextBridge.exposeInMainWorld('electronAPI',{interactiveCreate:input=>ipcRenderer.invoke('create',input),interactivePlace:input=>ipcRenderer.invoke('place',input),interactiveStop:id=>ipcRenderer.invoke('stop',id),appearanceShellState:(id,state)=>ipcRenderer.invoke('state',id,state),
onInteractiveStatus:cb=>listen('interactive-preview:status',cb),onAppearanceShellAction:cb=>listen('interactive-preview:appearance-action',cb),onAppearanceImageRequest:()=>()=>{},onAppearanceDocumentRequest:()=>()=>{}});`,
);
fs.writeFileSync(
  path.join(directory, 'main.cjs'),
  `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const {InteractivePreviews}=require(${JSON.stringify(path.join(desktop, 'dist/main/interactive-preview.js'))});
const {ThemeStorage}=require(${JSON.stringify(path.join(desktop, 'dist/main/theme-storage.js'))});
protocol.registerSchemesAsPrivileged([{scheme:'chatter-interactive',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',path.join(__dirname,'user-data'));const directory=path.join(__dirname,'state');let host,manager;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function until(check){const start=Date.now();while(!await check()){if(Date.now()-start>12000)throw Error('Storage fixture timeout');await sleep(30)}}
app.whenReady().then(async()=>{
host=new BrowserWindow({show:false,opacity:0,skipTaskbar:true,width:1000,height:750,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
const store=new ThemeStorage(directory);store.request('alpha',{operation:'set',key:'count',value:7});manager=new InteractivePreviews(undefined,undefined,store);
ipcMain.handle('create',(e,value)=>manager.create(e.sender,value));ipcMain.handle('place',(e,value)=>manager.place(e.sender,value));ipcMain.handle('stop',(e,id)=>manager.stop(e.sender,id));ipcMain.handle('state',(e,id,state)=>manager.updateAppearanceState(e.sender,id,state));
await host.loadFile(path.join(__dirname,'dist/index.html'));host.showInactive();const js=code=>host.webContents.executeJavaScript(code),entries=()=>[...manager.entries.values()],active=()=>entries().find(e=>e.visible&&e.ready);
await until(()=>active());await sleep(120);let first=active();const view=()=>active().view.webContents,theme=code=>view().executeJavaScript(code);
await until(()=>theme('document.querySelector("#count")?.textContent==="7"'));assert.equal(await theme('document.querySelector("#second").textContent'),'7');
assert.equal(await theme('(()=>{try{localStorage.setItem("x","y");return false}catch{return true}})()'),true,'raw localStorage remains isolated');
// Persistence must work without gesture tokens (e.g. after a drag or an effect).
async function click(selector){await theme('document.querySelector('+JSON.stringify(selector)+').click()');}
await click('#add');await until(()=>theme('document.querySelector("#second").textContent==="8"'));assert.equal(await theme('window.flushStorage()'),true);
assert.equal(new ThemeStorage(directory).read('alpha').values.count,8);
await js('window.setThemeId("beta")');await until(()=>active()?.id!==first.id&&active());await until(()=>theme('document.querySelector("#count")?.textContent==="0"'));
assert.equal(fs.existsSync(path.join(directory,'beta.json')),false,'reading fallback does not create a file');
await click('#add');await theme('window.flushStorage()');assert.equal(store.read('beta').values.count,1);assert.equal(store.read('alpha').values.count,8);
first=active();await js('window.setThemeId("alpha")');await until(()=>active()?.id!==first.id&&active());await until(()=>theme('document.querySelector("#count")?.textContent==="8"'));
first=active();await js('window.restartTheme()');await until(()=>active()?.id!==first.id&&active());await until(()=>theme('document.querySelector("#count")?.textContent==="8"'));
const current=active();
const staged=manager.create(host.webContents,{themeId:'alpha',bridge:'appearance-chat-list-v1',language:'html',source:'<main>staged</main>',dark:false,errorLabel:'error'});
const candidate=manager.entries.get(staged);await candidate.view.webContents.executeJavaScript('document.readyState');
await until(()=>candidate.ready);
assert.equal((await candidate.view.webContents.executeJavaScript('chatter.requestThemeStorage({operation:"read"})')).values.count,8);
assert.equal(await candidate.view.webContents.executeJavaScript('chatter.requestThemeStorage({operation:"set",key:"count",value:99}).then(()=>"bad",e=>e.message)'),'theme_storage_readonly');
manager.stop(host.webContents,staged);
store.request('alpha',{operation:'set',key:'count',value:20},'other-renderer');await until(()=>theme('document.querySelector("#count")?.textContent==="20"'));
await theme('chatter.requestThemeStorage({operation:"set",key:"spoof",value:1,themeId:"beta"})');assert.equal(store.read('alpha').values.spoof,1);assert.equal(store.read('beta').values.spoof,undefined,'theme code cannot choose a different namespace');
await click('#reset');await theme('window.flushStorage()');await until(()=>theme('document.querySelector("#count")?.textContent==="0"'));assert.equal(store.read('alpha').values.count,undefined);
assert.equal(await js('window.themeFailed||false'),false);
console.log('PASS: real hook/preload/host persistence, shared consumers, identical-shell theme isolation, renderer restart, HTML reads, staged-write rejection, committed updates, namespace spoof protection and reset');
}).catch(async error=>{console.error(error);for(const entry of manager?.entries.values()??[]){console.error('entry',entry.id,entry.visible,entry.ready,await entry.view.webContents.executeJavaScript('({html:document.body.innerHTML.slice(0,1800),error:document.querySelector("#error")?.textContent})').catch(()=>null));}process.exitCode=1}).finally(()=>{manager?.destroy();host?.destroy();app.exit(process.exitCode??0)});`,
);
try {
  await build({
    root: directory,
    base: './',
    configFile: false,
    logLevel: 'error',
    css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
    resolve: {
      alias: Object.fromEntries(
        ['react', 'react-dom', 'react-i18next', 'i18next'].map((name) => [
          name,
          path.join(desktop, 'node_modules', name),
        ]),
      ),
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
      output += '\nStorage UI timeout';
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
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
