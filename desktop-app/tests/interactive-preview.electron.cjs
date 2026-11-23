// Run after build:interactive + tsc -p tsconfig.main.json, using Electron (not Node).
const assert = require('node:assert/strict');
const { app, BrowserWindow, protocol, nativeImage } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
const { LocalAppearanceStore, appearanceImageResponse } = require('../dist/main/local-appearance.js');
protocol.registerSchemesAsPrivileged([
  { scheme: INTERACTIVE_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: 'chatter-theme', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-preview-test-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeout = 15000) => {
  const started = Date.now();
  while (!await predicate()) { if (Date.now() - started > timeout) throw new Error('Timed out'); await sleep(60); }
};
let host, manager, server;
app.whenReady().then(async () => {
  let hits = 0;
  let imageHits = 0;
  const fixtureImage = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 }).toPNG();
  server = createServer((req, res) => {
    if (req.url.startsWith('/theme-image?')) {
      imageHits++;
      if (!req.url.includes('token=host-private')) { res.writeHead(403); res.end(); return; }
      if (req.url.includes('bad=true')) { res.setHeader('Content-Type', 'text/html'); res.end('<script>bad</script>'); return; }
      res.setHeader('Content-Type', 'image/png'); res.end(fixtureImage); return;
    }
    hits++; res.end('must not be reached');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/blocked`;
  assert.equal(typeof appearanceImageResponse, 'function');
  const assetDirectory = path.join(app.getPath('userData'), 'themes');
  const assetStore = new LocalAppearanceStore(assetDirectory);
  protocol.handle('chatter-theme', request => appearanceImageResponse(request, host => host === assetStore.assetHost ? assetStore : undefined));
  host = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await host.loadURL('data:text/html,<body>Trusted host</body>');
  const pixelUrl = assetStore.importImage(nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 }).toPNG().toString('base64'));
  const imageWidth = await host.webContents.executeJavaScript(`new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth);image.onerror=()=>resolve(-1);image.src=${JSON.stringify(pixelUrl)};document.body.append(image);})`);
  assert.equal(imageWidth, 1, 'local theme resources render in Chromium');
  assert.equal(appearanceImageResponse({url:'chatter-theme://'+assetStore.assetHost+'/Windows/win.ini',method:'GET'},()=>assetStore).status,404);
  assert.equal(appearanceImageResponse({url:pixelUrl,method:'POST'},()=>assetStore).status,403);
  console.log('PASS: actual local-theme image protocol renders raster assets and rejects arbitrary paths/methods');
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
    'App.tsx': 'import React from "react"; import Counter from "@/parts"; import type {CounterState} from "./types"; import "./styles.css"; export default function App(){const [state,setState]=React.useState(null);React.useEffect(()=>window.chatter.subscribe(setState,{navigation:true}),[]);return <><h1>{state?.chats[0]?.title}</h1><Counter/></>}',
    'types.d.ts': 'export type CounterState = number;',
    'parts/index.ts': 'export {default} from "./Counter";',
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
  const forwarded = [], statuses = [], hostSend = host.webContents.send.bind(host.webContents);
  host.webContents.send = (channel, payload) => {
    if (channel === 'interactive-preview:appearance-action') forwarded.push(payload.action);
    if (channel === 'interactive-preview:status') statuses.push(payload);
    return hostSend(channel, payload);
  };
  const actionState = { ...shellState, activeChatId: 1, messages: [{ id: 10, variantIndex: 0, variantCount: 2, actions: ['copy','regenerate','speak','activateVariant'] }],
    speech: { messageId: 10, status: 'playing' }, confirmations: [{ id: 'request-1', title: 'Review', summary: 'Command' }] };
  await preview.contents.executeJavaScript('void window.chatter.subscribe(state=>window.latestThemeState=state,{confirmations:true})');
  manager.updateAppearanceState(host.webContents, preview.id, actionState);
  await until(async () => await preview.contents.executeJavaScript('window.latestThemeState?.activeChatId') === 1);
  assert.equal(await preview.contents.executeJavaScript('window.chatter.copyMessage(10)'), false, 'script effects have no user activation');
  assert.equal(await preview.contents.executeJavaScript('window.chatter.reviewConfirmation("request-1")'), false);
  assert.equal(await preview.contents.executeJavaScript('window.chatter.copyMessage(10)', true), true);
  await until(() => forwarded.some(action => action.type === 'messageAction' && action.action === 'copy'));
  assert.equal(await preview.contents.executeJavaScript('window.chatter.regenerateMessage(10,"More detail")', true), true);
  assert.equal(await preview.contents.executeJavaScript('window.chatter.reviewConfirmation("request-1")', true), true);
  await until(() => forwarded.some(action => action.type === 'reviewConfirmation' && action.id === 'request-1'));
  assert.ok(statuses.some(status => status.confirmations === true), 'custom request presentation is opt-in');
  manager.updateAppearanceState(host.webContents, preview.id, { ...actionState, messages: [{ ...actionState.messages[0], actions: [] }] });
  await until(async () => await preview.contents.executeJavaScript('window.latestThemeState.messages[0].actions.length') === 0);
  assert.equal(await preview.contents.executeJavaScript('window.chatter.copyMessage(10)', true), false, 'unavailable actions are not sent');
  host.webContents.send = hostSend;
  console.log('PASS: real isolated action bridge, user-gesture gating, confirmation review and capability negotiation');
  manager.stop(host.webContents, preview.id);
  const starter = JSON.parse(fs.readFileSync(path.join(__dirname, '../../examples/appearances/workspace-starter.json'), 'utf8'));
  preview = await create('tsx', '', { bridge: 'appearance-chat-list-v1', project: { entry: starter.shell.entry, files: starter.shell.files } });
  const starterState = { ...shellState, activeChatId: 1, query: '', messages: [], confirmations: [],
    labels: { allChats: 'All chats', newChat: 'New chat', search: 'Search', loadMore: 'More', edit: 'Edit', save: 'Save', cancel: 'Cancel', workLog: 'Work log', reasoning: 'Reasoning', loading: 'Loading' } };
  manager.updateAppearanceState(host.webContents, preview.id, starterState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector(".chat")?.textContent') === 'Live chat');
  manager.updateAppearanceState(host.webContents, preview.id, { ...starterState, view: 'conversation', canSend: true, messages: [{ id: 1, role: 'assistant', content: '# Live answer' }, { id: 2, role: 'assistant', content: '' }] });
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("article h1")?.textContent') === 'Live answer');
  assert.equal(await preview.contents.executeJavaScript('document.querySelectorAll("article").length'), 1, 'the starter excludes empty answers');
  const streamState = { ...starterState, view: 'conversation', sending: true, messages: [{ id: -1, role: 'assistant', content: 'Checking the file', streaming: true, workLog: [] }] };
  manager.updateAppearanceState(host.webContents, preview.id, streamState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("article p")?.textContent') === 'Checking the file');
  const toolCall = { id: 'stream-tool', name: 'read_file', label: 'Read file', kind: 'file', target: 'C:/demo.txt', status: 'running', arguments: { path: 'C:/demo.txt' }, children: [] };
  const committed = { ...streamState, messages: [{ ...streamState.messages[0], content: '', workLog: [{ type: 'message', text: 'Checking the file' }, { type: 'tool', call: toolCall }] }] };
  manager.updateAppearanceState(host.webContents, preview.id, committed);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("[data-tool-name=read_file]")?.dataset.status') === 'running');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector(".work-log p").textContent'), 'Checking the file', 'a committed preface remains rendered when the answer becomes empty');
  assert.equal(await preview.contents.executeJavaScript('document.querySelectorAll("article").length'), 1, 'work-log-only streaming messages remain visible');
  manager.updateAppearanceState(host.webContents, preview.id, { ...committed, sending: false, messages: [{ ...committed.messages[0], streaming: false, content: '# Result', workLog: [committed.messages[0].workLog[0], { type: 'tool', call: { ...toolCall, status: 'returned', resultPreview: '<script>unsafe</script>' } }] }] });
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("article h1")?.textContent') === 'Result');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("[data-tool-name=read_file]").dataset.status'), 'returned');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("[data-tool-name=read_file] script")'), null, 'tool previews are text, never executable HTML');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector(".work-log").open'), false, 'completed work log can be collapsed without losing its content');
  console.log('PASS: isolated starter retains intermediate text through tool streaming, renders live tool status and final answer safely');
  const resourceRequests = [];
  const allowedSources = new Set(['/api/v1/images/photo.png', '/api/v1/images/inline.png', '/api/v1/images/bad.png']);
  host.webContents.send = (channel, payload) => {
    if (channel === 'interactive-preview:appearance-image') {
      resourceRequests.push(payload);
      manager.resolveAppearanceImage({}, payload.id, payload.requestId, endpoint.replace('/blocked', '/theme-image?token=wrong-owner'));
      const allowed = payload.chatId === 1 && payload.messageId === 11 && payload.variantIndex === 0 && allowedSources.has(payload.url);
      manager.resolveAppearanceImage(host.webContents, payload.id, payload.requestId,
        allowed ? endpoint.replace('/blocked', '/theme-image?token=host-private' + (payload.url.endsWith('bad.png') ? '&bad=true' : '')) : null);
    }
    if (channel === 'interactive-preview:appearance-action') forwarded.push(payload.action);
    return hostSend(channel, payload);
  };
  const mediaMessage = { id: 11, role: 'assistant', content: '', variantIndex: 0, variantCount: 1, actions: [], workLog: [],
    images: [{ url: '/api/v1/images/photo.png', type: 'generated' }],
    attachments: [{ url: '/api/v1/attachments/demo.pdf', name: 'Report.pdf', filename: 'demo.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }] };
  const mediaState = { ...starterState, view: 'conversation', palette: { text: '#eee', accent: '#f80', surface: '#222' }, messages: [mediaMessage] };
  manager.updateAppearanceState(host.webContents, preview.id, mediaState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector(".chatter-message-images img")?.naturalWidth') === 1);
  assert.equal(await preview.contents.executeJavaScript('document.querySelectorAll("article").length'), 1, 'image/file-only messages stay visible');
  assert.equal(await preview.contents.executeJavaScript('document.body.innerHTML.includes("host-private")'), false, 'authenticated source URL never enters theme DOM');
  assert.ok(imageHits > 0);
  await preview.contents.executeJavaScript('document.querySelector(".chatter-message-images img").click()', true);
  await until(() => forwarded.some(action => action.type === 'contentAction' && action.action === 'openImage' && action.messageId === 11));
  await preview.contents.executeJavaScript('document.querySelector(".chatter-attachment button").click()', true);
  await until(() => forwarded.some(action => action.type === 'contentAction' && action.action === 'openAttachment' && action.index === 0));
  const markdownContent = '![Inline](/api/v1/images/inline.png "layout:gallery")\n\n[Chat](chat:1#10)\n\n```js\nconst answer = 42;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |';
  manager.updateAppearanceState(host.webContents, preview.id, { ...mediaState, messages: [{ ...mediaMessage, content: markdownContent }] });
  await until(async () => await preview.contents.executeJavaScript('document.querySelector("[data-message-images=gallery] img")?.naturalWidth') === 1);
  assert.equal(await preview.contents.executeJavaScript('document.querySelector(".chatter-markdown table td").textContent'), '1');
  assert.equal(await preview.contents.executeJavaScript('getComputedStyle(document.querySelector(".chatter-code")).borderTopWidth'), '1px', 'shared Markdown styles are loaded inside the isolated document');
  await preview.contents.executeJavaScript('document.querySelector(".chatter-code button").click()', true);
  await until(() => forwarded.some(action => action.type === 'contentAction' && action.action === 'copyText' && action.text === 'const answer = 42;'));
  await preview.contents.executeJavaScript('[...document.querySelectorAll(".chatter-message-link")].find(link=>link.textContent==="Chat").click()', true);
  await until(() => forwarded.some(action => action.type === 'contentAction' && action.action === 'openLink' && action.url === 'chat:1#10'));
  manager.updateAppearanceState(host.webContents, preview.id, { ...mediaState, messages: [{ ...mediaMessage, images: [{ url: '/api/v1/images/bad.png', type: 'external' }] }] });
  await until(async () => await preview.contents.executeJavaScript('!!document.querySelector(".chatter-image-error")'));
  assert.ok(resourceRequests.every(request => !request.url.includes('host-private')));
  host.webContents.send = hostSend;
  console.log('PASS: scoped authenticated image bytes, media-only messages, shared Markdown/gallery/code/table styles, native content actions and invalid-MIME fallback');
  host.webContents.send = (channel, payload) => {
    if (channel === 'interactive-preview:appearance-action') forwarded.push(payload.action);
    return hostSend(channel, payload);
  };
  const richCard = { id: 'full-card', title: 'Full confirmation', summary: 'Review details', ready: true, revision: 1, busy: false, customizable: true,
    content: [{ type: 'diff', before: 'old content', after: 'new content' }, { type: 'field', fieldId: 'body-0' }],
    fields: [{ id: 'body-0', label: 'Password', type: 'password', value: '', disabled: false }],
    actions: [{ id: 'primary-0', label: 'Approve custom', group: 'primary', disabled: false }] };
  const richState = { ...starterState, view: 'conversation', canSend: true, confirmations: [richCard], messages: [{ id: 10, role: 'assistant',
    content: 'Displayed answer', editableContent: '# Original source', variantIndex: 0, variantCount: 1, actions: ['edit'] }] };
  manager.updateAppearanceState(host.webContents, preview.id, richState);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector(".confirmation h2")?.textContent') === 'Full confirmation');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("[data-diff=before]").textContent'), 'old content');
  const inputText = async (selector, text) => preview.contents.executeJavaScript(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`, true);
  await inputText('.confirmation input', 'typed password');
  await until(() => forwarded.some(action => action.type === 'confirmationField' && action.id === 'full-card' && action.value === 'typed password'));
  assert.equal(await preview.contents.executeJavaScript('document.querySelector(".confirmation button").disabled'), true, 'approval waits for field acknowledgment');
  const acknowledged = { ...richState, confirmations: [{ ...richCard, revision: 2, fields: [{ ...richCard.fields[0], value: 'typed password' }] }] };
  manager.updateAppearanceState(host.webContents, preview.id, acknowledged);
  await until(async () => !await preview.contents.executeJavaScript('document.querySelector(".confirmation button").disabled'));
  await preview.contents.executeJavaScript('document.querySelector(".confirmation button").click()', true);
  await until(() => forwarded.some(action => action.type === 'confirmationAction' && action.id === 'full-card' && action.revision === 2));
  await preview.contents.executeJavaScript('document.querySelector(".message-actions button").click()', true);
  await until(async () => await preview.contents.executeJavaScript('document.querySelector(".message-actions textarea")?.value') === '# Original source');
  await inputText('.message-actions textarea', '# Updated original source');
  await preview.contents.executeJavaScript('document.querySelector(".message-actions form").requestSubmit()', true);
  await until(() => forwarded.some(action => action.type === 'messageAction' && action.action === 'edit' && action.text === '# Updated original source' && action.variantIndex === 0 && !action.nativeEditor));
  host.webContents.send = hostSend;
  console.log('PASS: isolated starter renders full confirmation fields/diffs/actions and saves custom message edits without native navigation');
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
    document.addEventListener('securitypolicyviolation',event=>{if(event.violatedDirective==='form-action')probe.formBlocked=true;});
    const forbiddenForm=document.createElement('form');forbiddenForm.action='${endpoint}';forbiddenForm.method='POST';document.body.append(forbiddenForm);forbiddenForm.requestSubmit();
    try{new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:3478'}]})}catch{probe.rtcBlocked=true}
    try{window.open('${endpoint}')}catch{probe.popupsBlocked=true}
    Promise.allSettled([fetch('${endpoint}'),fetch('file:///C:/Windows/win.ini')]).then(r=>probe.fetchBlocked=r.every(v=>v.status==='rejected'));
  </script><iframe src="${endpoint}"></iframe><img src="${endpoint}">`);
  await preview.contents.executeJavaScript('document.querySelector("button").click()');
  assert.equal(await preview.contents.executeJavaScript('document.querySelector("button").textContent'), 'Clicked');
  assert.deepEqual(await preview.contents.executeJavaScript('probe'), { rtcBlocked: true, popupsBlocked: true, fetchBlocked: true, formBlocked: true });
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
