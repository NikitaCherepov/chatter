import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  require = createRequire(import.meta.url);
const { build } = require('vite'),
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-proposal-preview-'));
const source = fs
  .readFileSync(path.join(desktop, 'src/renderer/pages/ChatPage.tsx'), 'utf8')
  .replaceAll('\r\n', '\n');
// Use ChatPage's real queue filtering and lifecycle callbacks in a focused host,
// without authentication, server requests, chat history or account data.
const extract = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  const to = source.indexOf(end, from);
  assert.ok(to > from, end);
  return source.slice(from, to);
};
const applied = extract(
  '  useEffect(() => {\n    const done = (event: Event) => {',
  '  useEffect(() => setAppearanceEditorDraft',
);
const startPreview = extract(
  '  useEffect(() => {\n    if (!appearancePreview) return;',
  '  const [settingsTarget',
);
// The next state declaration may move independently of the effect.
const previewEffect = startPreview.slice(
  0,
  startPreview.indexOf('}, [appearancePreview?.id, Boolean(appearancePreview)]);') +
    '}, [appearancePreview?.id, Boolean(appearancePreview)]);'.length,
);
const queue = extract('...appearanceProposals.filter(', ',\n    ...pendingRunbooks');
const modulePath = (file: string) =>
  JSON.stringify(path.join(desktop, 'src/renderer', file).replaceAll('\\', '/'));
const theme = `import React from 'react';import {useChatterState} from '@chatter/ui';
export default function App(){const state=useChatterState({confirmations:true});const [clicks,setClicks]=React.useState(0);
return <main><button id="working" onClick={()=>setClicks(n=>n+1)}>Working {clicks}</button>
{state?.confirmations?.map(card=><div id="proposal-modal" key={card.id} role="dialog" aria-modal="true" style={{position:'fixed',inset:0,background:'#eee',padding:60}}>
{card.actions.map(action=><button key={action.id} data-preview={action.label==='Предпросмотр'||undefined} disabled={action.disabled} onClick={()=>chatter.runConfirmationAction(card.id,action.id,card.revision)}>{action.label}</button>)}</div>)}</main>}`;
fs.writeFileSync(
  path.join(directory, 'index.html'),
  '<div id="root"></div><script type="module" src="/app.tsx"></script>',
);
fs.writeFileSync(
  path.join(directory, 'service.ts'),
  `export const useAppearance=()=>window.appearanceQuery;export const readLocalDraft=async()=>window.profile;`,
);
fs.writeFileSync(
  path.join(directory, 'sample.tsx'),
  `import React from 'react';export function AppearanceSample(){return <span>Appearance sample</span>}`,
);
fs.writeFileSync(
  path.join(directory, 'app.tsx'),
  `
import React,{useEffect,useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import i18n from 'i18next';import {initReactI18next} from 'react-i18next';
import translations from ${modulePath('i18n/locales/ru/translation.json')};
i18n.use(initReactI18next).init({lng:'ru',resources:{ru:{translation:translations}},interpolation:{escapeValue:false},initImmediate:false});
import {AppearanceShell} from ${modulePath('components/AppearanceShell.tsx')};
import {AppearanceConfirmation} from ${modulePath('components/AppearanceConfirmation.tsx')};
import {AppearanceController} from ${modulePath('components/AppearanceController.tsx')};
import {ConfirmationQueue} from ${modulePath('components/ConfirmationCard.tsx')};
import {useConfirmationBridge} from ${modulePath('lib/useConfirmationBridge.ts')};
import {newAppearance} from ${modulePath('lib/appearance-schema.ts')};
import {APPEARANCE_APPLIED_EVENT,getAppearancePreview,subscribeAppearancePreview} from ${modulePath('lib/appearance-runtime.ts')};
const shell={version:1,language:'tsx',scope:'workspace',entry:'App.tsx',files:{'App.tsx':${JSON.stringify(theme)}}};
window.profile={...newAppearance('proposal-fixture'),shell};window.writes=[];
window.appearanceQuery={data:{version:1,revision:1,activeId:window.profile.id,profiles:[window.profile]},saving:false,change:async command=>window.writes.push(command)};
const composer={comment:null,busy:false,cancel(){},registerReject(){return()=>{}}};
function App(){const [appearanceProposals,setAppearanceProposals]=useState([{proposal_id:'proposal',profile:window.profile}]);
const appearancePreview=useSyncExternalStore(subscribeAppearancePreview,getAppearancePreview);
const [shellOpen,setShellOpen]=useState(true),[showSettings,setShowSettings]=useState(false),[libraryOpen,setLibraryOpen]=useState(false),[shellView,setShellView]=useState('home');
const [,setAppearanceEditorDraft]=useState();const bridge=useConfirmationBridge();const [custom,setCustom]=useState(false);
${applied}
${previewEffect}
const confirmationCards=[${queue}];window.proposalCount=appearanceProposals.length;window.projectedCount=bridge.cards.length;
const ids=new Set(confirmationCards.map(card=>card.props.proposal.proposal_id));
const state={scopeId:'fixture',chats:[],sections:[],messages:[],view:shellView,activeChatId:null,confirmations:bridge.cards.filter(card=>ids.has(card.id))};
return <><AppearanceController/><div style={{position:'absolute',inset:'40px 0 100px'}}>
<AppearanceShell shell={appearancePreview?.shell??shell} state={state} visible={shellOpen&&!showSettings&&!libraryOpen} onClose={()=>setShellOpen(false)} onFailure={()=>{}}
onAction={action=>{if(action.type==='confirmationPresentation')setCustom(action.custom);if(action.type==='confirmationAction')void bridge.api.execute(action.id,action.actionId,action.revision);}}/>
<ConfirmationQueue items={confirmationCards} order={new Map()} composer={composer} bridge={bridge.api} custom={custom}/></div></>;
}createRoot(document.getElementById('root')).render(<App/>);`,
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
const assert=require('node:assert/strict'),path=require('node:path');const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const {InteractivePreviews}=require(${JSON.stringify(path.join(desktop, 'dist/main/interactive-preview.js'))});
protocol.registerSchemesAsPrivileged([{scheme:'chatter-interactive',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',path.join(__dirname,'user-data'));let host,manager;const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const start=Date.now();while(!await check()){if(Date.now()-start>12000)throw Error('Proposal preview fixture timeout');await sleep(30)}}
app.whenReady().then(async()=>{
host=new BrowserWindow({show:false,opacity:0,skipTaskbar:true,width:1100,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}});
manager=new InteractivePreviews();ipcMain.handle('create',(e,value)=>manager.create(e.sender,value));ipcMain.handle('place',(e,value)=>manager.place(e.sender,value));ipcMain.handle('stop',(e,id)=>manager.stop(e.sender,id));ipcMain.handle('state',(e,id,state)=>manager.updateAppearanceState(e.sender,id,state));
await host.loadFile(path.join(__dirname,'dist/index.html'));host.showInactive();const js=code=>host.webContents.executeJavaScript(code),entries=()=>[...manager.entries.values()],active=()=>entries().find(e=>e.ready&&e.visible);
await until(()=>active());await sleep(150);const first=active(),view=first.view.webContents,theme=code=>view.executeJavaScript(code);
await until(()=>theme('!!document.querySelector("[data-preview]")'));
// Supply a Chromium user gesture without depending on OS focus for a transparent fixture window.
async function click(contents,selector){await contents.executeJavaScript('document.querySelector('+JSON.stringify(selector)+').click()',true);}
await click(view,'[data-preview]');await until(()=>js('!!document.querySelector("[role=region]")'));
await until(()=>theme('!document.querySelector("#proposal-modal")'));
assert.equal(active().id,first.id,'unchanged shell is reused: dismiss the proposal through state, not a renderer restart');
assert.equal(await js('window.proposalCount'),1,'preview does not dismiss the proposal');assert.equal(await js('window.writes.length'),0,'preview does not apply settings');
await click(view,'#working');await until(()=>theme('document.querySelector("#working").textContent==="Working 1"'));
await js('document.querySelector("[role=region] button:last-of-type").click()');await until(()=>theme('!!document.querySelector("[data-preview]")'));
await click(view,'[data-preview]');await until(()=>theme('!document.querySelector("#proposal-modal")'));
await js('document.querySelector("[role=region] button").click()');await until(()=>js('window.proposalCount===0'));
assert.equal(await js('window.writes.length'),1);assert.equal(await js('window.writes[0].apply'),true);
await sleep(100);assert.equal(await theme('!!document.querySelector("#proposal-modal")'),false);
console.log('PASS: real projected proposal preview releases modal and clicks without restarting unchanged shell; cancel restores proposal; explicit apply resolves suspended proposal');
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{manager?.destroy();host?.destroy();app.exit(process.exitCode??0)});`,
);
try {
  await build({
    root: directory,
    base: './',
    configFile: false,
    logLevel: 'error',
    plugins: [
      {
        name: 'fixture-boundaries',
        enforce: 'pre',
        resolveId(id: string, importer: string) {
          if (id.endsWith('/appearance-service')) return path.join(directory, 'service.ts');
          if (id === './AppearancePanel' && importer?.endsWith('/AppearanceConfirmation.tsx'))
            return path.join(directory, 'sample.tsx');
          if (id.endsWith('/api') && importer?.endsWith('/AppearanceController.tsx'))
            return '\0fixture-api';
        },
        load(id: string) {
          if (id === '\0fixture-api')
            return 'export const resolveAuthenticatedAssetUrl=value=>value;';
        },
      },
    ],
    resolve: {
      alias: Object.fromEntries(
        ['react', 'react-dom', 'react-i18next', 'i18next', 'framer-motion'].map((name) => [
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
      output += '\nProposal preview timeout';
      child.kill();
    }, 45000);
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
