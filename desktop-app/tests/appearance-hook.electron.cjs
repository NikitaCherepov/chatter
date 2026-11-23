// Run after npm run build, with Electron.
const assert = require('node:assert/strict');
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
protocol.registerSchemesAsPrivileged([{ scheme: INTERACTIVE_SCHEME, privileges: { standard: true, secure: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-hook-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > 15000) throw new Error('Hook fixture timed out'); await sleep(30); }
}
let host, manager;
app.whenReady().then(async () => {
  host = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await host.loadURL('data:text/html,<body>Host</body>');
  manager = new InteractivePreviews();
  const id = manager.create(host.webContents, { language: 'tsx', source: '', dark: true, errorLabel: 'Hook failed', bridge: 'appearance-chat-list-v1', project: {
    entry: 'App.tsx', files: { 'App.tsx': `import React from 'react';import {useChatterState} from '@chatter/ui';
function Reader(){const state=useChatterState();return <p id="plain">{state?.query??'loading'}</p>}
function Owner({navigation,id}){const state=useChatterState({navigation,confirmations:true});return <p id={id}>{state?.query??'loading'}</p>}
function App(){const [left,setLeft]=React.useState(true),[right,setRight]=React.useState(true),[nav,setNav]=React.useState(true),[count,setCount]=React.useState(0),[all,setAll]=React.useState(true);
return <main><button id="tick" onClick={()=>setCount(n=>n+1)}>{count}</button><button id="nav" onClick={()=>setNav(v=>!v)}>Navigation</button><button id="left" onClick={()=>setLeft(v=>!v)}>Left</button><button id="right" onClick={()=>setRight(v=>!v)}>Right</button><button id="all" onClick={()=>setAll(v=>!v)}>All</button>{all&&<><Reader/>{left&&<Owner id="owner-left" navigation={nav}/>} {right&&<Owner id="owner-right" navigation={false}/>}</>}</main>}
export default function Root(){return <React.StrictMode><App/></React.StrictMode>}` },
  } });
  const contents = host.contentView.children.at(-1).children[0].webContents;
  const changes = [];
  contents.on('ipc-message', (_event, channel, value) => {
    if (['appearance-shell:navigation', 'appearance-shell:confirmations'].includes(channel)) changes.push([channel, value]);
  });
  const js = source => contents.executeJavaScript(source);
  const click = selector => contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
  let state = { view: 'home', activeChatId: 1, query: 'initial', messages: [], confirmations: [], chats: [], sections: [] };
  manager.updateAppearanceState(host.webContents, id, state);
  await until(async () => await js('document.querySelector("#plain")?.textContent') === 'initial');
  await sleep(100);
  assert.ok(changes.some(([channel, value]) => channel === 'appearance-shell:navigation' && value === true));
  assert.ok(changes.some(([channel, value]) => channel === 'appearance-shell:confirmations' && value === true));
  changes.length = 0;
  await click('#tick');
  await until(async () => await js('document.querySelector("#tick")?.textContent') === '1');
  // Same boolean options in fresh inline objects must not resubscribe on a render or route update.
  manager.updateAppearanceState(host.webContents, id, { ...state, view: 'conversation', query: 'conversation' });
  await until(async () => await js('document.querySelector("#plain")?.textContent') === 'conversation');
  manager.updateAppearanceState(host.webContents, id, state);
  await until(async () => await js('document.querySelector("#owner-left")?.textContent') === 'initial');
  assert.equal(await js('document.querySelector("#tick").textContent'), '1', 'the hook opts into state-preserving home navigation');
  assert.deepEqual(changes, []);
  await click('#right');
  await until(async () => !await js('!!document.querySelector("#owner-right")'));
  assert.deepEqual(changes, [], 'one hook owner leaving must not disable the remaining owner');
  await click('#nav');
  await until(() => changes.length === 1);
  assert.deepEqual(changes.splice(0), [['appearance-shell:navigation', false]], 'changing navigation must not flicker confirmations');
  await click('#nav');
  await until(() => changes.length === 1);
  assert.deepEqual(changes.splice(0), [['appearance-shell:navigation', true]]);
  await click('#right');
  await until(async () => !!await js('document.querySelector("#owner-right")'));
  await click('#left');
  await until(() => changes.length === 1);
  assert.deepEqual(changes.splice(0), [['appearance-shell:navigation', false]], 'the remaining confirmation owner keeps confirmations enabled');
  await click('#left');
  await until(async () => !!await js('document.querySelector("#owner-left")'));
  await sleep(100);
  assert.equal(changes.filter(([channel]) => channel === 'appearance-shell:confirmations').length, 0);
  assert.deepEqual(changes.at(-1), ['appearance-shell:navigation', true]);
  changes.length = 0;
  // A direct API subscriber must retain ownership after all hook owners leave.
  await js('void (window.releaseDirect=window.chatter.subscribe(()=>{},{navigation:true,confirmations:true}))');
  await click('#left');
  await until(async () => !await js('!!document.querySelector("#owner-left")'));
  await click('#right');
  await until(async () => !await js('!!document.querySelector("#owner-right")'));
  assert.deepEqual(changes, [], 'removing hook owners must not disable a direct subscriber');
  await js('window.releaseDirect();window.releaseDirect()');
  await until(() => changes.length === 2);
  assert.deepEqual(changes.splice(0), [['appearance-shell:navigation', false], ['appearance-shell:confirmations', false]]);
  state = { ...state, query: 'still reading' };
  manager.updateAppearanceState(host.webContents, id, state);
  await until(async () => await js('document.querySelector("#plain")?.textContent') === 'still reading');
  await click('#all');
  await until(async () => !await js('!!document.querySelector("#plain")'));
  state = { ...state, query: 'updated without readers' };
  manager.updateAppearanceState(host.webContents, id, state);
  await click('#all');
  await until(async () => await js('document.querySelector("#plain")?.textContent') === 'updated without readers');
  assert.deepEqual(changes, [], 'a plain reader does not claim custom navigation or confirmations');
  console.log('PASS: real hook options, multiple owners/plain readers, StrictMode, dynamic flags without capability flicker, route-state retention, direct subscribers, idempotent cleanup and remount snapshots');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  manager?.destroy(); host?.destroy(); app.exit(process.exitCode ?? 0);
});
