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

const fixture = String.raw`
import React, { useState, useLayoutEffect } from 'react';
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
const i18n = createInstance();
i18n
  .init({
    lng: 'ru',
    resources: { ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    createRoot(document.getElementById('root')).render(<App />);
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
        'window.fixtureReady && (location.hash === "#baseline" ? document.querySelectorAll("[data-message-id]").length === 60 : document.querySelectorAll("[data-virtual-message-id]").length === 60)',
      );
      await sleep(200);
    };
    const metrics = () =>
      js(
        '({height:window.scroller.current.getMetrics().scrollHeight,top:window.scroller.current.getMetrics().scrollTop,mounted:document.querySelectorAll("[data-message-id]").length,nodes:document.querySelector("#root").querySelectorAll("*").length,rows:document.querySelectorAll("[data-virtual-message-id]").length,placeholders:document.querySelectorAll("[data-message-placeholder]").length})',
      );
    await load('baseline');
    const baseline = await metrics();
    await load('');
    await until('document.querySelectorAll("[data-message-placeholder]").length>40');
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
    await until('document.querySelectorAll("[data-message-placeholder]").length>40');
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
    await until('document.querySelectorAll("[data-message-placeholder]").length===0');
    assert.ok(
      await js('getSelection().toString().length>100000'),
      'selection must include loaded offscreen messages',
    );
    await js('getSelection().removeAllRanges()');
    await until('document.querySelectorAll("[data-message-placeholder]").length>40');

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
