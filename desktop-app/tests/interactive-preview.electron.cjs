// Run after build:interactive + tsc -p tsconfig.main.json, using Electron (not Node).
const assert = require('node:assert/strict');
const { app, BrowserWindow, protocol } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
protocol.registerSchemesAsPrivileged([{ scheme: INTERACTIVE_SCHEME, privileges: { standard: true, secure: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-preview-test-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 15000) => {
  const started = Date.now();
  while (!await predicate()) { if (Date.now() - started > timeout) throw new Error('Timed out'); await sleep(60); }
};
let host, manager, server;
app.whenReady().then(async () => {
  let hits = 0;
  server = createServer((_req, res) => { hits++; res.end('must not be reached'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/blocked`;
  host = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await host.loadURL('data:text/html,<body>Trusted host</body>');
  manager = new InteractivePreviews();
  const create = async (language, source, options = {}) => {
    const id = manager.create(host.webContents, { language, source, dark: true, errorLabel: 'Preview failed', ...options });
    const contents = host.contentView.children.at(-1).children[0].webContents;
    contents.on('console-message', (_event, level, message) => { if (level >= 2) console.log('sandbox:', message.slice(0, 180)); });
    await until(() => !contents.isLoading());
    await sleep(500);
    return { id, contents };
  };
  let preview = await create('interactive', 'export default function Counter(){const [n,setN]=React.useState(0);return <button onClick={()=>setN(n+1)}>Count: {n}</button>}');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button")?.textContent'), 'Count: 0');
  await preview.contents.executeJavaScript('document.querySelector("button").click()');
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("button").textContent') === 'Count: 1');
  assert.deepEqual(await preview.contents.executeJavaScript('[typeof electronAPI,typeof require,typeof process]'), ['undefined','undefined','undefined']);
  assert.notEqual(preview.contents.getOSProcessId(), host.webContents.getOSProcessId());
  assert.equal(preview.contents.getLastWebPreferences().sandbox, true);
  assert.equal(preview.contents.getLastWebPreferences().preload, undefined);
  manager.place(host.webContents, { id: preview.id, visible: true, bounds: { x: 10, y: 50, width: 400, height: 360 }, clip: { x: 10, y: 120, width: 400, height: 150 } });
  assert.deepEqual(host.contentView.children[0].getBounds(), { x: 10, y: 120, width: 400, height: 150 });
  assert.equal(host.contentView.children[0].children[0].getBounds().y, -70);
  const processId = preview.contents.getOSProcessId();
  manager.place(host.webContents, { id: preview.id, visible: true, expanded: true,
    bounds: { x: 20, y: 70, width: 900, height: 600 }, clip: { x: 20, y: 70, width: 900, height: 600 } });
  assert.equal(preview.contents.getOSProcessId(), processId);
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button").textContent'), 'Count: 1');
  manager.place(host.webContents, { id: preview.id, visible: true, expanded: false,
    bounds: { x: 10, y: 50, width: 400, height: 360 }, clip: { x: 10, y: 50, width: 400, height: 360 } });
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button").textContent'), 'Count: 1');
  assert.equal(await preview.contents.executeJavaScript('(()=>{try{localStorage.setItem("private-test","one");return false}catch{return true}})()'), true);
  assert.equal(await preview.contents.executeJavaScript(`(()=>{const frame=document.createElement('iframe');document.body.append(frame);try{return typeof frame.contentWindow.RTCPeerConnection === 'undefined'}catch{return true}})()`), true, 'child realms must not recover blocked APIs');
  manager.stop(host.webContents, preview.id);
  preview = await create('html', '<div style="min-height:100vh;padding:24px;display:flex;align-items:center"><button>Fits</button></div>');
  for (const zoom of [1, 1.2]) {
    host.webContents.setZoomFactor(zoom);
    for (const height of [200, 360, 640]) {
      manager.place(host.webContents, { id: preview.id, visible: true,
        bounds: { x: 10, y: 50, width: 400, height }, clip: { x: 10, y: 50, width: 400, height } });
      await sleep(80);
      const metrics = await preview.contents.executeJavaScript('({scroll:document.documentElement.scrollHeight,client:document.documentElement.clientHeight,gutter:innerWidth-document.documentElement.clientWidth})');
      assert.equal(metrics.scroll, metrics.client, JSON.stringify({zoom,height,metrics}));
      assert.equal(metrics.gutter, 0, 'a fitting 100vh layout must not reserve a scrollbar gutter');
    }
  }
  host.webContents.setZoomFactor(1);
  await preview.contents.executeJavaScript('document.querySelector("div").style.height="1200px"');
  assert.equal(await preview.contents.executeJavaScript('document.documentElement.scrollHeight>document.documentElement.clientHeight'), true, 'genuine overflow remains scrollable');
  manager.stop(host.webContents, preview.id);
  preview = await create('tsx', 'import {useState} from "react"; export default function App(){const [n]=useState<number>(7);return <p>TSX {n}</p>}');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("p")?.textContent'), 'TSX 7');
  assert.equal(await preview.contents.executeJavaScript('(()=>{try{localStorage.getItem("private-test");return false}catch{return true}})()'), true);
  manager.stop(host.webContents, preview.id);
  const project = { entry: 'App.tsx', files: {
    'App.tsx': 'import React from "react"; import Counter from "./parts/Counter"; import "./styles.css"; export default function App(){const [state,setState]=React.useState(null);React.useEffect(()=>window.chatter.subscribe(setState,{navigation:true}),[]);return <><h1>{state?.chats[0]?.title}</h1><Counter/></>}',
    'parts/Counter.tsx': 'import React from "react"; import data from "../data.json"; import {format} from "./format"; export default function Counter(){const [n,setN]=React.useState(0);return <button onClick={()=>setN(n+1)}>{format(data.label,n)}</button>}',
    'parts/format.ts': 'export function format(label:string,n:number){return label+": "+n}',
    'data.json': '{"label":"Project"}',
    'styles.css': 'button { color: rgb(1, 2, 3); }',
  } };
  assert.throws(() => manager.create(host.webContents, { language: 'tsx', source: '', dark: true, errorLabel: '', project }), /Invalid appearance project/, 'projects require the appearance bridge');
  preview = await create('tsx', '', { bridge: 'appearance-chat-list-v1', project });
  const shellState = { chats: [{ id: 1, title: 'Live chat' }], sections: [], view: 'home' };
  manager.updateAppearanceState(host.webContents, preview.id, shellState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("h1")?.textContent') === 'Live chat');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button")?.textContent'), 'Project: 0');
  assert.equal(await preview.contents.executeJavaScript('getComputedStyle(document.querySelector("button")).color'), 'rgb(1, 2, 3)');
  assert.deepEqual(await preview.contents.executeJavaScript('[typeof window.chatter,typeof electronAPI,typeof require,typeof process]'), ['object','undefined','undefined','undefined']);
  await preview.contents.executeJavaScript('document.querySelector("button").click()');
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("button").textContent') === 'Project: 1');
  manager.updateAppearanceState(host.webContents, preview.id, { ...shellState, view: 'conversation' });
  await sleep(100);
  manager.updateAppearanceState(host.webContents, preview.id, shellState);
  await sleep(100);
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button").textContent'), 'Project: 1', 'project modules and state survive route-aware return');
  manager.stop(host.webContents, preview.id);
  const starter = JSON.parse(fs.readFileSync(path.join(__dirname, '../../examples/appearances/workspace-starter.json'), 'utf8'));
  preview = await create('tsx', '', { bridge: 'appearance-chat-list-v1', project: { entry: starter.shell.entry, files: starter.shell.files } });
  const starterState = { ...shellState, query: '', messages: [], labels: { allChats: 'All chats', newChat: 'New chat', search: 'Search', loadMore: 'More' } };
  manager.updateAppearanceState(host.webContents, preview.id, starterState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector(".chat")?.textContent') === 'Live chat');
  manager.updateAppearanceState(host.webContents, preview.id, { ...starterState, view: 'conversation', canSend: true, messages: [{ id: 1, role: 'assistant', content: '# Live answer' }, { id: 2, role: 'assistant', content: '' }] });
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("article h1")?.textContent') === 'Live answer');
  assert.equal(await preview.contents.executeJavaScript('document.querySelectorAll("article").length'), 1, 'the starter excludes empty answers');
  await preview.contents.executeJavaScript('document.querySelector("textarea").focus()');
  manager.updateAppearanceState(host.webContents, preview.id, { ...starterState, view: 'conversation', canSend: false, sending: true });
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("form button")?.textContent') === 'Stop');
  assert.equal(await preview.contents.executeJavaScript('document.activeElement.tagName'), 'TEXTAREA', 'stream updates retain composer focus');
  manager.updateAppearanceState(host.webContents, preview.id, starterState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector(".chat")?.textContent') === 'Live chat');
  manager.stop(host.webContents, preview.id);
  console.log('PASS: importable workspace starter home/conversation, Markdown, empty-answer handling and composer focus during updates');
  manager.create(host.webContents, { language: 'tsx', source: '', dark: true, errorLabel: 'Preview failed', bridge: 'appearance-chat-list-v1', project: {
    entry: 'App.tsx', files: { 'App.tsx': 'import Missing from "./missing"; export default function App(){return null}' },
  } });
  await until(() => host.contentView.children.length === 0);
  assert.equal(await host.webContents.executeJavaScript('2+2'), 4, 'an invalid project returns control to the host');
  console.log('PASS: virtual TSX project, relative component/JSON/CSS imports, live bridge, state-preserving routing and invalid-project recovery');
  preview = await create('jsx', 'export default function Broken(){ throw new Error("broken") }');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("[role=alert]")?.textContent'), 'Preview failed');
  manager.stop(host.webContents, preview.id);
  preview = await create('html', `<h1>HTML works</h1><button onclick="this.textContent='Clicked'">Click</button><script>
    window.probe={};
    try{new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:3478'}]})}catch{probe.rtcBlocked=true}
    try{window.open('${endpoint}')}catch{probe.popupsBlocked=true}
    Promise.allSettled([fetch('${endpoint}'),fetch('file:///C:/Windows/win.ini')]).then(r=>probe.fetchBlocked=r.every(v=>v.status==='rejected'));
  </script><iframe src="${endpoint}"></iframe><img src="${endpoint}">`);
  await preview.contents.executeJavaScript('document.querySelector("button").click()');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button").textContent'), 'Clicked');
  assert.deepEqual(await preview.contents.executeJavaScript('probe'), { rtcBlocked: true, popupsBlocked: true, fetchBlocked: true });
  void preview.contents.executeJavaScript(`location.href='${endpoint}'`).catch(() => {});
  await sleep(400);
  assert.ok(preview.contents.getURL().startsWith(`${INTERACTIVE_SCHEME}://`));
  assert.equal(hits, 0, 'no HTTP request may leave the sandbox');
  manager.stop(host.webContents, preview.id);
  preview = await create('html', '<button onclick="while(true){}">Hang</button>');
  void preview.contents.executeJavaScript('document.querySelector("button").click()').catch(() => {});
  await until(() => host.contentView.children.length === 0, 12000);
  assert.equal(await host.webContents.executeJavaScript('2+2'), 4, 'host survives blocked preview');
  console.log('PASS: React/TSX/HTML, state, crash boundary, separate renderer/storage, offline navigation/API restrictions, clipping and hang recovery');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  manager?.destroy(); host?.destroy(); server?.close(); app.exit(process.exitCode ?? 0);
});
