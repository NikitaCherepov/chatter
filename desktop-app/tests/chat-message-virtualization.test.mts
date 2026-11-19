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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-virtual-history-'));
const modulePath = (file: string) =>
  JSON.stringify(path.resolve(desktopRoot, 'src/renderer', file).replaceAll('\\', '/'));

// Run the actual ChatPage history callbacks with a controlled API and real scroll DOM.
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
function pageEffect(marker: string): string {
  let result: string | undefined;
  const visit = (node: any) => {
    if (ts.isCallExpression(node) && ['useEffect', 'useLayoutEffect'].includes(node.expression.getText(pageAst))) {
      const text = node.getText(pageAst);
      if (text.includes(marker)) result = text;
    }
    ts.forEachChild(node, visit);
  };
  visit(pageAst);
  assert.ok(result, 'ChatPage effect not found: ' + marker);
  return result;
}
const autoFixture = String.raw`
const MESSAGE_PAGE_SIZE = 50;
const MIN_VISIBLE_MESSAGES = 8;
const getRenderPerfStep = () => 2000;
type ChatPageMessage = { id: number; content: string };
function AutoHistoryApp() {
  const short = location.hash === '#auto-short';
  const initialItems = () => Array.from({ length: short ? 8 : 24 }, (_, index) =>
    short ? { id: index + 1, content: 'Короткое сообщение' } : makeItem(index + 1));
  const [messages, setMessages] = useState(initialItems);
  const [activeChatId, setActiveChatId] = useState(1);
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  const messagesChatIdRef = useRef(activeChatId);
  messagesChatIdRef.current = activeChatId;
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [charBudget, setCharBudget] = useState(2000);
  const olderMessagesRequestRef = useRef<object | null>(null);
  const suppressNextMessageAutoScrollRef = useRef(false);
  const prevMsgCountRef = useRef(0);
  ${pageEffect('olderMessagesRequestRef.current = null;')};
  const api = { getMessages(chatId, limit, offset) {
    window.historyRequests.push({ chatId, limit, offset });
    return new Promise((resolve, reject) => window.historyResponses.push({ resolve, reject }));
  } };
  const loadOlderMessages = ${pageSnippet('loadOlderMessages')};
  const displayMessages = messages;
  const visibleMessages = ${pageSnippet('visibleMessages')};
  const hiddenMessagesCount = messages.length - visibleMessages.length;
  const showMoreHidden = ${pageSnippet('showMoreHidden')};
  const messagesScrollRef = scroller;
  ${pageEffect('if (suppressNextMessageAutoScrollRef.current)')};
  window.historyState = { chatId: activeChatId, visible: visibleMessages.length, total: messages.length,
    hidden: hiddenMessagesCount, loading: loadingOlderMessages, error: olderMessagesError, ready: !loadingMessages };
  window.retryOlder = loadOlderMessages;
  window.historyReady = (ready) => flushSync(() => setLoadingMessages(!ready));
  window.switchHistory = (id) => flushSync(() => {
    setActiveChatId(id);
    setMessages(initialItems());
    setCharBudget(2000);
    setHasMoreMessages(true);
    suppressNextMessageAutoScrollRef.current = true;
  });
  window.finishOlder = (fail = false, count = 2) => {
    const pending = window.historyResponses.shift();
    if (fail) pending.reject(new Error('Expected offline fixture'));
    else pending.resolve({ messages: Array.from({length:count}, (_, index) =>
      ({ id: -count + index, content: short ? 'Раннее сообщение' : makeItem(-count + index).content })) });
  };
  return <ChatMessagesScroll ref={scroller} className={s.messages} contentClassName={s.messagesContent}
    resetKey={activeChatId} positionScope="auto-fixture" ready={!loadingMessages} virtualize
    onReachStart={!loadingMessages && !loadingOlderMessages && !olderMessagesError
      && (hiddenMessagesCount > 0 || hasMoreMessages) ? showMoreHidden : undefined}>
    {(loadingOlderMessages || olderMessagesError) && <div className={s.loadingRow} role="status">
      {olderMessagesError ? <button onClick={loadOlderMessages}>Повторить</button> : 'Загрузка…'}
    </div>}
    {visibleMessages.map(item => <VirtualMessage key={item.id} id={item.id} revision={item}>
      <Body item={item}/>
    </VirtualMessage>)}
  </ChatMessagesScroll>;
}
`;
const fixture = String.raw`
import React, { useState, useLayoutEffect, useCallback, useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ChatMessagesScroll } from ${modulePath('components/ChatMessagesScroll.tsx')};
import { VirtualMessage } from ${modulePath('components/VirtualMessage.tsx')};
import { MarkdownRenderer } from ${modulePath('components/MarkdownRenderer.tsx')};
import ru from ${modulePath('i18n/locales/ru/translation.json')};
import s from ${modulePath('pages/ChatPage.module.scss')};
import ${modulePath('global.scss')};
const makeItem = (id) => ({
  id,
  content:
    '# Сообщение ' +
    id +
    '\n\n' +
    Array.from(
      { length: 16 + (Math.abs(id) % 8) },
      (_, n) =>
        'Абзац ' +
        n +
        '. Длинный текст с **форматированием**, [ссылкой](https://example.com/) и сохранением положения при прокрутке.',
    ).join('\n\n'),
});
const scroller = React.createRef();
window.scroller = scroller;
window.unmounts = 0;
function Body({ item }) {
  useLayoutEffect(
    () => () => {
      window.unmounts++;
    },
    [],
  );
  return (
    <div className={s.messageGroup} data-message-id={item.id}>
      <span data-avatar style={{ position: 'absolute', left: -40 }}>
        V
      </span>
      <div className={s.metaRow}>Vega</div>
      <details>
        <summary>Рассуждение</summary>
        <div style={{ height: 120 }}>Раскрытое рассуждение</div>
      </details>
      {item.id === 1 && <input aria-label="Сохраняемый ответ" defaultValue="" />}
      <MarkdownRenderer content={item.content} deferOffscreen />
    </div>
  );
}
function App() {
  const [items, setItems] = useState(() => Array.from({ length: 60 }, (_, n) => makeItem(n + 1)));
  const [chat, setChat] = useState(1);
  const [pinned, setPinned] = useState(null);
  window.items = items;
  window.setChat = (id) => flushSync(() => setChat(id));
  window.pin = (id) => flushSync(() => setPinned(id));
  window.grow = (id) =>
    flushSync(() =>
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                content:
                  item.content +
                  '\n\n' +
                  Array.from({ length: 12 }, () => 'Новые строки в старом сообщении.').join('\n\n'),
              }
            : item,
        ),
      ),
    );
  window.prepend = () => flushSync(() => setItems((prev) => [makeItem(-2), makeItem(-1), ...prev]));
  return (
    <I18nextProvider i18n={i18n}>
      <ChatMessagesScroll
        ref={scroller}
        className={s.messages}
        contentClassName={s.messagesContent}
        resetKey={chat}
        positionScope="fixture"
        virtualize={location.hash !== '#baseline'}
      >
        {items.map((item, index) => {
          const body = (
            <>
              {index % 10 === 0 && <div className={s.messageDay}>19 ноября</div>}
              <Body item={item} />
            </>
          );
          return location.hash === '#baseline' ? (
            <React.Fragment key={item.id}>{body}</React.Fragment>
          ) : (
            <VirtualMessage
              key={item.id}
              id={item.id}
              revision={item}
              keepMounted={pinned === item.id || item.id === 1}
            >
              {body}
            </VirtualMessage>
          );
        })}
      </ChatMessagesScroll>
    </I18nextProvider>
  );
}
${autoFixture}
const i18n = createInstance();
i18n
  .init({
    lng: 'ru',
    resources: { ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    window.historyRequests = [];
    window.historyResponses = [];
    createRoot(document.getElementById('root')).render(location.hash.startsWith('#auto') ? <AutoHistoryApp /> : <App />);
    window.fixtureReady = true;
  });
`;

const electronFixture = String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(__dirname, 'user-data'));
setTimeout(() => {
  console.error('Virtual history test timed out');
  app.exit(1);
}, 60000);
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents,
      errors = [];
    wc.on('console-message', (_event, level, message) => {
      if (level === 3) errors.push(message);
    });
    wc.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    const js = (code) => wc.executeJavaScript(code);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await js(code)) return;
        await sleep(30);
      }
      throw new Error('Condition timed out: ' + code);
    };
    const load = async (hash) => {
      await win.loadURL('about:blank');
      await win.loadFile(path.join(__dirname, 'renderer/index.html'), { hash });
      await until(
        'window.fixtureReady && (location.hash.startsWith("#auto") ? !!window.historyState : location.hash === "#baseline" ? document.querySelectorAll("[data-message-id]").length === 60 : document.querySelectorAll("[data-virtual-row-id]").length === 60)',
      );
      await sleep(200);
    };
    const metrics = () =>
      js(
        '({height:window.scroller.current.getMetrics().scrollHeight,top:window.scroller.current.getMetrics().scrollTop,mounted:document.querySelectorAll("[data-message-id]").length,nodes:document.querySelector("#root").querySelectorAll("*").length,rows:document.querySelectorAll("[data-virtual-row-id]").length,placeholders:document.querySelectorAll("[data-virtual-row-placeholder]").length})',
      );
    await load('baseline');
    const baseline = await metrics();
    await load('');
    await until('document.querySelectorAll("[data-virtual-row-placeholder]").length>40');
    const virtual = await metrics();
    console.log(JSON.stringify({ baseline, virtual }));
    assert.ok(
      Math.abs(baseline.height - virtual.height) <= 2,
      'virtual history must keep the full measured height',
    );
    assert.ok(
      virtual.mounted < 10 && virtual.nodes < baseline.nodes / 4,
      'offscreen message DOM must actually be released',
    );
    assert.ok(await js('window.unmounts>40'));

    assert.equal(await js('window.scroller.current.scrollToMessage(25,{immediate:true})'), true);
    await until('!!document.querySelector("[data-message-id=\\"25\\"]")');
    await sleep(150);
    const rect = await js(
      '(()=>{const rect=document.querySelector("[data-message-id=\\"25\\"]").getBoundingClientRect();return{top:rect.top,bottom:rect.bottom};})()',
    );
    assert.ok(
      rect.top < 700 && rect.bottom > 0,
      'an app-search jump must reveal and scroll to an unmounted message',
    );

    await js(
      'window.scroller.current.scrollToMessage(45);window.scroller.current.scrollToMessage(15,{immediate:true})',
    );
    await until(
      'Array.from(document.querySelectorAll("[data-message-id]")).some(element=>element.dataset.messageId==="15")',
    );
    await sleep(150);
    assert.ok(
      await js(
        'Array.from(document.querySelectorAll("[data-message-id]")).find(element=>element.dataset.messageId==="15").getBoundingClientRect().top<700',
      ),
    );
    await until(
      '!Array.from(document.querySelectorAll("[data-message-id]")).some(element=>element.dataset.messageId==="45")',
    );
    await js('window.scroller.current.scrollTo(0,{immediate:true})');
    await until('!!document.querySelector("[data-message-id=\\"2\\"]")');
    await js(
      '(()=>{const input=document.querySelector("input");input.value="Мой ответ";window.savedInput=input;const details=document.querySelector("[data-message-id=\\"2\\"] details");details.open=true;})()',
    );
    await js('window.pin(3);window.scroller.current.scrollTo("end",{immediate:true})');
    await until('document.querySelectorAll("[data-virtual-row-placeholder]").length>40');
    assert.equal(
      await js(
        'document.querySelector("input")===window.savedInput&&window.savedInput.value==="Мой ответ"',
      ),
      true,
    );
    assert.equal(
      await js('!!document.querySelector("[data-message-id=\\"2\\"] details[open]")'),
      true,
      'expanded local state must stay mounted',
    );
    assert.equal(
      await js('!!document.querySelector("[data-message-id=\\"3\\"]")'),
      true,
      'streaming/editing pins must remain mounted',
    );
    await js(
      'document.querySelector("[data-message-id=\\"2\\"] details").open=false;window.pin(null)',
    );
    await until(
      '!document.querySelector("[data-message-id=\\"2\\"]")&&!document.querySelector("[data-message-id=\\"3\\"]")',
    );

    await js('window.scroller.current.scrollToMessage(30,{immediate:true})');
    await until('!!document.querySelector("[data-message-id=\\"30\\"]")');
    await sleep(150);
    const beforeGrowth = await js(
      'document.querySelector("[data-message-id=\\"30\\"]").getBoundingClientRect().top',
    );
    await js(
      '(' +
        function () {
          window.grow(4);
        }.toString() +
        ')()',
    );
    await sleep(250);
    await wc.capturePage();
    await sleep(100);
    const afterGrowth = await js(
      'document.querySelector("[data-message-id=\\"30\\"]").getBoundingClientRect().top',
    );
    assert.ok(
      Math.abs(beforeGrowth - afterGrowth) <= 2,
      'remeasuring an offscreen update must preserve the visible message',
    );
    await js('window.prepend()');
    await sleep(250);
    await until(
      'Math.abs((Array.from(document.querySelectorAll("[data-message-id]")).find(element=>element.dataset.messageId==="30")?.getBoundingClientRect().top ?? Infinity)-' +
        beforeGrowth +
        ')<=2',
    );
    const beforeWidth = await js(
      'document.querySelector("[data-message-id=\\"30\\"]").getBoundingClientRect().top',
    );
    win.setContentSize(650, 700);
    await sleep(350);
    await until(
      'Math.abs((Array.from(document.querySelectorAll("[data-message-id]")).find(element=>element.dataset.messageId==="30")?.getBoundingClientRect().top ?? Infinity)-' +
        beforeWidth +
        ')<=2',
    );

    await js(
      '(()=>{const root=document.querySelector("#root");const range=document.createRange();range.selectNodeContents(root);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()',
    );
    await until('document.querySelectorAll("[data-virtual-row-placeholder]").length===0');
    assert.ok(
      await js('getSelection().toString().length>100000'),
      'selection must include loaded offscreen messages',
    );
    await js('getSelection().removeAllRanges()');
    await until('document.querySelectorAll("[data-virtual-row-placeholder]").length>40');

    await js('window.setChat(2)');
    await sleep(200);
    const chatTwo = await metrics();
    assert.ok(chatTwo.height - chatTwo.top < 750, 'a fresh chat must start at the bottom');
    await js('window.setChat(1)');
    await sleep(250);
    await until(
      'Math.abs((Array.from(document.querySelectorAll("[data-message-id]")).find(element=>element.dataset.messageId==="30")?.getBoundingClientRect().top ?? Infinity)-' +
        beforeWidth +
        ')<=2',
    );
    assert.deepEqual(errors, []);

    // Automatic cached batches, then a single remote request near the top.
    await load('auto');
    await until('window.historyState?.visible === 8');
    assert.equal(await js('window.historyRequests.length'), 0, 'opening at the bottom must not fetch old history');
    await js('window.scroller.current.scrollTo(250,{immediate:true})');
    await until('window.historyState.visible > 8');
    assert.equal(await js('window.historyRequests.length'), 0, 'cached history must be revealed first');
    assert.equal(await js('window.historyState.visible'), 9, 'one oversized message must still make progress');
    await until('window.scroller.current.getMetrics().scrollTop > 400');
    for (let step = 0; step < 30; step++) {
      const state = await js('window.historyState');
      if (state.loading) break;
      const previous = state.visible;
      await js('window.scroller.current.scrollTo(200,{immediate:true})');
      await until('window.historyState.loading || window.historyState.visible > ' + previous);
      await sleep(40);
    }
    await until('window.historyRequests.length === 1 && window.historyState.loading');
    assert.deepEqual(await js('window.historyRequests[0]'), { chatId: 1, limit: 50, offset: 24 });
    await js('window.retryOlder();window.retryOlder();window.scroller.current.scrollTo(0,{immediate:true})');
    await sleep(120);
    assert.equal(await js('window.historyRequests.length'), 1, 'in-flight requests must not be duplicated');
    await js('window.scroller.current.scrollToMessage(16,{immediate:true})');
    await sleep(150);
    const readingBeforeResponse = await js('document.querySelector("[data-message-id=\\"16\\"]").getBoundingClientRect().top');
    await js('window.finishOlder()');
    await until('window.historyState.total === 26 && !window.historyState.loading');
    await until('Math.abs(document.querySelector("[data-message-id=\\"16\\"]").getBoundingClientRect().top - ' + readingBeforeResponse + ') <= 2');
    await js('window.scroller.current.scrollTo(0,{immediate:true})');
    await sleep(150);
    assert.equal(await js('window.historyRequests.length'), 1, 'end of history must stop automatic requests');

    // Short histories fill automatically; an error pauses until an explicit retry.
    await load('auto-short');
    await until('window.historyRequests.length === 1');
    await js('window.finishOlder(true)');
    await until('window.historyState.error && !window.historyState.loading');
    await js('window.scroller.current.scrollTo(0,{immediate:true})');
    await sleep(150);
    assert.equal(await js('window.historyRequests.length'), 1, 'an error must not create an automatic retry loop');
    await js('document.querySelector("[role=status] button").click()');
    await until('window.historyRequests.length === 2 && window.historyState.loading');
    await js('window.finishOlder(false, 50)');
    await until('window.historyState.total === 58 && !window.historyState.loading');
    await sleep(100);
    assert.equal(await js('window.historyRequests.length'), 2, 'filling the viewport must not drain all history');
    await js('window.historyReady(false);window.scroller.current.scrollTo(0,{immediate:true})');
    await sleep(100);
    assert.equal(await js('window.historyRequests.length'), 2, 'an unready chat must not load more history');
    await js('window.historyReady(true)');
    await until('window.historyRequests.length === 3');
    await js('window.finishOlder()');
    await until('!window.historyState.loading');

    // Returning to the same chat must invalidate its earlier pending request too.
    await load('auto-short');
    await until('window.historyRequests.length === 1');
    await js('window.switchHistory(2)');
    await until('window.historyRequests.length === 2');
    await js('window.switchHistory(1)');
    await until('window.historyRequests.length === 3');
    await js('window.finishOlder();window.finishOlder()');
    await sleep(120);
    assert.equal(await js('window.historyState.total'), 8, 'stale responses must not modify the current chat');
    assert.equal(await js('window.historyState.loading'), true, 'a stale request must not clear the current loading state');
    await js('window.finishOlder()');
    await until('window.historyState.total === 10 && !window.historyState.loading');
    assert.equal(errors.filter(message => message.startsWith('Failed to load older messages:')).length, 1);
    assert.deepEqual(errors.filter(message => !message.startsWith('Failed to load older messages:')), []);
    console.log('PASS: automatic cached batches, oversized-message progress, remote pagination, reading position during requests, short-history fill, single-flight requests, error retry, history end and stale-chat responses');
    win.destroy();
    console.log(
      'PASS: DOM reduction, exact measured heights, search jumps, interactive pins, selection, history prepending, source updates, width changes and chat scroll restoration',
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
`;

try {
  await build({
    configFile: false,
    root: desktopRoot,
    logLevel: 'error',
    plugins: [
      {
        name: 'virtual-history-fixture',
        resolveId(id: string) {
          if (id === 'virtual-history.tsx') return '\0' + id;
        },
        async load(id: string) {
          if (id === '\0virtual-history.tsx')
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
        input: 'virtual-history.tsx',
        output: { entryFileNames: 'entry.js' },
        onwarn(warning: { code?: string }, warn: (warning: unknown) => void) {
          if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
        },
      },
    },
  });
  const css = fs
    .readdirSync(path.join(directory, 'renderer/assets'))
    .find((name) => name.startsWith('_virtual-history') && name.endsWith('.css'));
  assert.ok(css);
  fs.writeFileSync(
    path.join(directory, 'renderer/index.html'),
    '<meta charset="UTF-8"><link rel="stylesheet" href="./assets/' +
      css +
      '"><style>body{background:var(--bg-secondary);font-size:14px;line-height:1.6}#root{height:100%;display:flex;flex-direction:column}</style>' +
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
      reject(new Error('Virtual history fixture timed out'));
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
  assert.ok(path.basename(directory).startsWith('chatter-virtual-history-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
