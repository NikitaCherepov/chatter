import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const desktopRoot = path.join(root, 'desktop-app');
const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'));
const { build, transformWithEsbuild } = desktopRequire('vite');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-virtual-sidebar-'));
const modulePath = (file: string) =>
  JSON.stringify(path.resolve(desktopRoot, 'src/renderer', file).replaceAll('\\', '/'));

// Render the actual sidebar rows, folders and DnD handlers with controlled chat data.
const ts = desktopRequire('typescript');
const pageSource = fs.readFileSync(path.join(desktopRoot, 'src/renderer/pages/ChatPage.tsx'), 'utf8');
const pageAst = ts.createSourceFile('ChatPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageSnippet(name: string): string {
  let result: string | undefined;
  const visit = (node: any) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === name) {
      result = node.initializer.getText(pageAst);
    }
    ts.forEachChild(node, visit);
  };
  visit(pageAst);
  assert.ok(result, 'ChatPage callback not found: ' + name);
  return result;
}

function pageFunction(name: string): string {
  const node = pageAst.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, 'ChatPage function not found: ' + name);
  return node.getText(pageAst);
}
function pageJsx(marker: string, tag: string): string {
  let result: string | undefined;
  const visit = (node: any) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(pageAst) === tag) {
      const text = node.getText(pageAst);
      if (text.includes(marker)) result = text;
    }
    ts.forEachChild(node, visit);
  };
  visit(pageAst);
  assert.ok(result, 'ChatPage JSX not found: ' + marker);
  return result;
}
const plainChat = pageJsx('chatDragHandle', 'DemoDraggableChat');
const searchMarkup = pageJsx('searchResults.map', 'div');
const plainSearchRow = pageJsx('result.chat_id === activeChatId', 'div')
  .replace('<div', '<div key={result.chat_id}');
const plainSearchMarkup = searchMarkup.replace(pageJsx('revision={result}', 'VirtualRow'), plainSearchRow);

const fixture = String.raw`
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { DndContext, DragOverlay, closestCenter, pointerWithin, useDraggable, useDroppable } from '@dnd-kit/core';
import { createInstance } from 'i18next';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { VirtualRow, VirtualRowsContext, useVirtualRows } from ${modulePath('components/VirtualRows.tsx')};
import { Tooltip } from ${modulePath('components/Tooltip.tsx')};
import { groupChatsByActivity } from ${modulePath('lib/chat-date-groups.ts')};
import ru from ${modulePath('i18n/locales/ru/translation.json')};
import s from ${modulePath('pages/ChatPage.module.scss')};
import ${modulePath('global.scss')};
${pageFunction('DemoDraggableChat')}
${pageFunction('DemoDroppableFolder')}
${pageFunction('ChatSectionSentinel')}
${pageFunction('FolderIcon')}
const chatFolderCollisionDetection = ${pageSnippet('chatFolderCollisionDetection')};
function Sidebar() {
  const baseline = location.hash === '#baseline';
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [chats, setChats] = useState(() => Array.from({length:600}, (_, index) => ({
    id: index + 1,
    title: 'Чат ' + (index + 1) + ' — длинное название для проверки сокращения текста',
    folder_id: index < 500 ? Math.floor(index / 100) + 1 : null,
    created_at: (Date.now() - (index % 40) * 86400000) / 1000,
  })));
  const chatFolders = useMemo(() => Array.from({length:5}, (_, index) => ({
    id: index + 1, name:'Папка ' + (index + 1), chat_count: chats.filter(chat => chat.folder_id === index + 1).length,
  })), [chats]);
  const [activeChatId, setActiveChatId] = useState(1);
  const [searching, setSearching] = useState(false);
  const searchQuery = 'search';
  const searchLoading = false;
  const searchResults = useMemo(() => Array.from({length:300}, (_, index) => ({
    chat_id:1001+index,message_id:2001+index,chat_title:'Результат ' + (index+1),
    created_at:Date.now()/1000,folder_id:null,
    snippet:Array.from({length:2+(index%4)},()=> 'Разная длина найденного фрагмента.').join(' '),
  })), []);
  const renderSnippet = ${pageSnippet('renderSnippet')};
  const pendingMessageJumpRef = useRef(null);
  const setHighlightedMessageId = () => {};
  const loadMessages = () => {};
  const handleSearchClear = () => setSearching(false);
  const [renamingChatId, setRenamingChatId] = useState(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [contextMenuChatId, setContextMenuChatId] = useState(null);
  const [demoDraggingChatId, setDemoDraggingChatId] = useState(null);
  const [demoDraggingChatSize, setDemoDraggingChatSize] = useState(null);
  const [demoExpandedFolders, setDemoExpandedFolders] = useState({});
  const [demoRenamingFolderId, setDemoRenamingFolderId] = useState(null);
  const [demoRenamingFolderName, setDemoRenamingFolderName] = useState('');
  const [demoFolderMenuId, setDemoFolderMenuId] = useState(null);
  const demoFolderMenuPos = {x:0,y:0};
  const [sectionPaging, setSectionPaging] = useState({ unfiled: {hasMore:false,loading:false} });
  const [width, setWidth] = useState(300);
  const sidebarScrollRef = useRef(null);
  const sidebarViewport = useVirtualRows(sidebarScrollRef, 'sidebar-test', !baseline);
  const getUnread = (id) => id % 7 === 0 ? 3 : 0;
  const formatTime = () => '19 нояб., 14:50';
  const selectChat = (id) => setActiveChatId(id);
  const handleKebabClick = (event, id) => {event.stopPropagation();setContextMenuChatId(id);};
  const handleConfirmRename = () => {};
  const handleRenameKeyDown = () => {};
  const finishDemoFolderRename = () => setDemoRenamingFolderId(null);
  const startDemoFolderRename = (id, name) => {setDemoRenamingFolderId(id);setDemoRenamingFolderName(name);};
  const toggleDemoFolderMenu = (event, id) => {event.stopPropagation();setDemoFolderMenuId(id);};
  const deleteDemoFolder = () => {};
  const toggleDemoFolder = ${pageSnippet('toggleDemoFolder')};
  const moveDemoChat = (chatId, folderId) => {
    window.lastDrop = {chatId, folderId};
    setChats(prev => prev.map(chat => chat.id === chatId ? {...chat, folder_id:folderId} : chat));
  };
  const handleDemoChatDragStart = ${pageSnippet('handleDemoChatDragStart')};
  const handleDemoChatDragEnd = ${pageSnippet('handleDemoChatDragEnd')};
  const renderSidebarChat = baseline ? ((chat, nested = false) => (${plainChat})) : ${pageSnippet('renderSidebarChat')};
  const demoFolders = ${pageSnippet('demoFolders')};
  const demoUnfiledChats = ${pageSnippet('demoUnfiledChats')};
  const chatGroupingNow = useMemo(() => new Date(), []);
  const unfiledDateGroups = ${pageSnippet('unfiledDateGroups')};
  const dateGroupCounts = undefined;
  const demoDraggingChat = chats.find(chat => chat.id === demoDraggingChatId);
  const unfiledChatCount = demoUnfiledChats.length;
  const loadingChats = false;
  const loadChatSection = (folderId) => {
    if (folderId !== null || window.pageRequests) return;
    window.pageRequests++;
    setSectionPaging({unfiled:{hasMore:false,loading:false}});
    setChats(prev => [...prev,...Array.from({length:25}, (_, index) => ({
      id: 601 + index, folder_id:null, title:'Подгруженный чат ' + (index+1), created_at:Date.now()/1000,
    }))]);
  };
  window.classes = s;
  window.sidebarState = {activeChatId, searching, renamingChatId, contextMenuChatId, demoDraggingChatId, total:chats.length};
  window.jumpToChat = id => sidebarViewport.reveal('chat-' + id, () => {
    const row = document.querySelector('[data-virtual-row-id="chat-' + id + '"]');
    row.scrollIntoView({block:'center'});
  });
  window.scrollSidebar = top => { sidebarScrollRef.current.scrollTop = top === 'end' ? sidebarScrollRef.current.scrollHeight : top; };
  window.renameChat = id => flushSync(() => { setRenamingChatId(id);setRenamingTitle('Черновик имени'); });
  window.menuChat = id => flushSync(() => setContextMenuChatId(id));
  window.toggleFolder = id => flushSync(() => toggleDemoFolder(id));
  window.narrowSidebar = () => flushSync(() => setWidth(230));
  window.searchSidebar = () => flushSync(() => {setWidth(300);setSearching(true);});
  window.pendingResult = pendingMessageJumpRef;
  window.enablePaging = () => flushSync(() => setSectionPaging({unfiled:{hasMore:true,loading:false}}));
  return <div className={s.sidebar} style={{width,height:'100%'}}>
    <div ref={sidebarScrollRef} className={s.sidebarContentBody} data-sidebar-scroll>
      <VirtualRowsContext.Provider value={sidebarViewport}>
        {searching ? baseline ? (${plainSearchMarkup}) : (${searchMarkup}) : (
          ${pageJsx('collisionDetection={chatFolderCollisionDetection}', 'DndContext')}
        )}
      </VirtualRowsContext.Provider>
    </div>
  </div>;
}
const i18n = createInstance();
window.pageRequests = 0;
// Hidden Electron windows do not deliver native pointer moves during capture.
// Dispatch the same pointer events to exercise dnd-kit's real sensors and collision logic.
window.moveDrag = (x,y) => document.dispatchEvent(new PointerEvent('pointermove', {
  bubbles:true,pointerId:1,isPrimary:true,pointerType:'mouse',buttons:1,clientX:x,clientY:y,
}));
i18n.init({lng:'ru',resources:{ru:{translation:ru}},interpolation:{escapeValue:false}}).then(() => {
  createRoot(document.getElementById('root')).render(<I18nextProvider i18n={i18n}><Sidebar/></I18nextProvider>);
  window.fixtureReady = true;
});
`;

const electronFixture = String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(__dirname, 'user-data'));
setTimeout(() => { console.error('Sidebar test timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false,width:900,height:720,useContentSize:true,
    webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (_event, level, message) => {if(level === 3) errors.push(message);});
  wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, cb) => cb({cancel:true}));
  const js = code => wc.executeJavaScript(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    for(let n=0;n<120;n++) { if(await js(code)) return; await sleep(25); }
    throw new Error('Condition timed out: ' + code);
  };
  const load = async hash => {
    await win.loadURL('about:blank');
    await win.loadFile(path.join(__dirname,'renderer/index.html'),{hash});
    await until('window.fixtureReady && document.querySelectorAll("[aria-roledescription=draggable]").length > 0');
    await sleep(250);
  };
  const metrics = () => js('(()=>{const root=document.querySelector("[data-sidebar-scroll]");return {height:root.scrollHeight,nodes:root.querySelectorAll("*").length,draggables:root.querySelectorAll("[aria-roledescription=draggable]").length,placeholders:root.querySelectorAll("[data-virtual-row-placeholder]").length,headers:[...root.querySelectorAll("."+window.classes.demoFolderHeader)].map(el=>el.getBoundingClientRect().top+root.scrollTop)};})()');
  await load('baseline');
  const baseline = await metrics();
  await js('window.toggleFolder(1)');
  await wc.capturePage();
  await until('document.querySelectorAll("." + window.classes.demoFolderChats).length === 4');
  const collapsedBaseline = await metrics();
  await js('window.searchSidebar();window.scrollSidebar(0)');
  await until('document.querySelectorAll("."+window.classes.searchSnippet).length === 300');
  const baselineSearch = await metrics();
  await load('');
  await until('document.querySelectorAll("[data-virtual-row-placeholder]").length > 500');
  const virtual = await metrics();
  console.log(JSON.stringify({baseline,virtual}));
  assert.equal(baseline.height,virtual.height,'virtual rows must preserve the original sidebar height and margins');
  assert.deepEqual(virtual.headers,baseline.headers,'folder positions must match the original layout');
  assert.ok(virtual.draggables < 45 && virtual.nodes < baseline.nodes / 4,'offscreen chat hooks and DOM must be released');
  await js('window.toggleFolder(1)');
  await wc.capturePage();
  await until('document.querySelectorAll("." + window.classes.demoFolderChats).length === 4');
  const collapsed = await metrics();
  assert.equal(collapsed.height,collapsedBaseline.height,'folder collapse must keep its original animation/layout');
  await js('window.toggleFolder(1)');
  await wc.capturePage();
  await until('document.querySelectorAll("." + window.classes.demoFolderChats).length === 5 && document.querySelector("[data-sidebar-scroll]").scrollHeight === ' + baseline.height);
  await js('window.jumpToChat(3)');
  await until('!!document.querySelector("[data-virtual-row-id=chat-3] [aria-roledescription=draggable]")');
  await js('window.renameChat(3)');
  await until('!!document.querySelector("[data-virtual-row-id=chat-3] input")');
  await js('window.savedRenameInput=document.querySelector("[data-virtual-row-id=chat-3] input");window.scrollSidebar("end")');
  await until('!!document.querySelector("[data-virtual-row-id=chat-600] [aria-roledescription=draggable]")');
  assert.ok(await js('document.contains(window.savedRenameInput) && window.savedRenameInput.value==="Черновик имени"'),
    'renaming must survive scrolling far away');
  await js('window.renameChat(null);window.menuChat(2)');
  await until('!!document.querySelector("[data-virtual-row-id=chat-2] [aria-roledescription=draggable]")');
  await sleep(80);
  assert.ok(await js('!!document.querySelector("[data-virtual-row-id=chat-2] [aria-roledescription=draggable]")'),
    'a chat with an open menu must stay mounted');
  await js('window.menuChat(null)');
  await until('!document.querySelector("[data-virtual-row-id=chat-2] [aria-roledescription=draggable]")');
  await js('window.enablePaging()');
  await until('window.pageRequests === 1 && window.sidebarState.total === 625');
  await sleep(100);
  assert.equal(await js('window.pageRequests'),1,'the existing automatic section pagination must still work once');
  await js('window.jumpToChat(3)');
  await until('!!document.querySelector("[data-virtual-row-id=chat-3] [aria-roledescription=draggable]")');
  await sleep(100);
  const point = await js('(()=>{const rect=document.querySelector("[data-virtual-row-id=chat-3] [aria-roledescription=draggable]").getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};})()');
  wc.sendInputEvent({type:'mouseMove',...point});
  wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  await js('window.moveDrag(' + (point.x+15) + ',' + (point.y+15) + ')');
  await until('window.sidebarState.demoDraggingChatId === 3');
  await js('window.scrollSidebar("end")');
  await sleep(120);
  assert.ok(await js('!!document.querySelector("[data-virtual-row-id=chat-3] [aria-roledescription=draggable]")'),
    'the active drag source must stay mounted offscreen');
  await js('window.moveDrag(160,600)');
  await sleep(100);
  wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:160,y:600});
  await until('!!window.lastDrop');
  assert.deepEqual(await js('window.lastDrop'),{chatId:3,folderId:null},'drag and drop into the unfiled section must survive virtualization');
  await until('window.sidebarState.demoDraggingChatId === null');
  const topBeforeResize = await js('document.querySelector("[data-sidebar-scroll]").scrollTop');
  await js('window.narrowSidebar()');
  await sleep(150);
  assert.ok(Math.abs(await js('document.querySelector("[data-sidebar-scroll]").scrollTop')-topBeforeResize)<=2);
  await js('window.searchSidebar();window.scrollSidebar(0)');
  await until('document.querySelectorAll("[data-virtual-row-placeholder]").length > 250');
  await until('!!document.querySelector("[data-virtual-row-id=search-1001-2001] ."+window.classes.searchSnippet)');
  const virtualSearch = await metrics();
  assert.equal(virtualSearch.height,baselineSearch.height,'variable search snippets must preserve their original height and spacing');
  assert.ok(virtualSearch.nodes < baselineSearch.nodes / 3,'search results must be virtualized too');
  await js('document.querySelector("[data-virtual-row-id=search-1001-2001] ."+window.classes.chatItem).click()');
  await until('window.sidebarState.activeChatId === 1001 && !window.sidebarState.searching');
  assert.deepEqual(await js('window.pendingResult.current'), {chatId:1001,messageId:2001,query:'search'},
    'selecting a virtualized result must preserve the jump to its matching message');
  assert.deepEqual(errors,[]);
  win.destroy();
  console.log('PASS: sidebar DOM reduction, exact spacing, folder animation, renaming/menu pins, automatic pagination, pointer-sensor drag across a virtualized list, width changes, variable search snippets, search-result jumps and no renderer errors');
  app.exit(0);
}).catch(error => {console.error(error);app.exit(1);});
`;
try {
  await build({
    configFile: false,
    root: desktopRoot,
    logLevel: 'error',
    plugins: [
      {
        name: 'virtual-sidebar-fixture',
        resolveId(id: string) {
          if (id === 'virtual-sidebar.tsx') return '\0' + id;
        },
        async load(id: string) {
          if (id === '\0virtual-sidebar.tsx')
            return transformWithEsbuild(fixture, 'fixture.tsx', {
              loader: 'tsx',
              jsx: 'automatic',
            });
        },
      },
    ],
    css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
    build: {
      outDir: path.join(directory, 'renderer'),
      rollupOptions: {
        input: 'virtual-sidebar.tsx',
        output: { entryFileNames: 'entry.js' },
        onwarn(warning: { code?: string }, warn: (warning: unknown) => void) {
          if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
        },
      },
    },
  });
  const css = fs
    .readdirSync(path.join(directory, 'renderer/assets'))
    .find((name) => name.startsWith('_virtual-sidebar') && name.endsWith('.css'));
  assert.ok(css);
  fs.writeFileSync(
    path.join(directory, 'renderer/index.html'),
    '<meta charset="UTF-8"><link rel="stylesheet" href="./assets/' + css +
      '"><style>#root{height:100%;display:flex;font-size:14px;line-height:1.6}</style>' +
      '<div id="root"></div><script type="module" src="./entry.js"></script>',
  );
  fs.writeFileSync(path.join(directory, 'main.cjs'), electronFixture);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopRequire('electron'), [path.join(directory, 'main.cjs')], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Virtual sidebar fixture timed out'));
    }, 65000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  process.stdout.write(output);
  assert.equal(code, 0);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('chatter-virtual-sidebar-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
