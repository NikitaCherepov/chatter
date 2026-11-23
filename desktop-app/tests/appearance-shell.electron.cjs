// Run after build:interactive and tsc -p tsconfig.main.json, using Electron.
const assert = require('node:assert/strict');
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
protocol.registerSchemesAsPrivileged([
  { scheme: INTERACTIVE_SCHEME, privileges: { standard: true, secure: true } },
]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-appearance-shell-'));
app.setPath('userData', directory);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message = 'Timed out') {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > 15000) throw new Error(message);
    await sleep(50);
  }
}
let host, stranger, manager, offscreen;
app
  .whenReady()
  .then(async () => {
    const events = [];
    host = new BrowserWindow({
      show: false,
      width: 1200,
      height: 850,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    stranger = new BrowserWindow({ show: false });
    await host.loadURL('data:text/html,<body>Host remains available</body>');
    const originalSend = host.webContents.send.bind(host.webContents);
    host.webContents.send = (channel, ...args) => {
      events.push({ channel, value: args[0] });
      originalSend(channel, ...args);
    };
    manager = new InteractivePreviews();
    const profile = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../examples/appearances/holographic.json'),
        'utf8',
      ),
    );
    assert.equal(
      profile.shell.files[profile.shell.entry],
      fs.readFileSync(
        path.resolve(__dirname, '../../examples/appearances/holographic.html'),
        'utf8',
      ),
    );
    const create = (source, language = 'html', bridge = 'appearance-chat-list-v1') => {
      const id = manager.create(host.webContents, {
        source: '',
        project: { entry: language === 'html' ? 'index.html' : 'App.tsx', files: { [language === 'html' ? 'index.html' : 'App.tsx']: source } },
        language,
        bridge,
        dark: true,
        errorLabel: 'Broken shell',
      });
      const contents = host.contentView.children.at(-1).children[0].webContents;
      return { id, contents };
    };
    let preview = create(profile.shell.files[profile.shell.entry]);
    const state = {
      chats: Array.from({ length: 4 }, (_, index) => ({
        id: index + 1,
        title: ['Северное сияние', 'Сжатие видео', 'Идеи на выходные', 'Рабочие заметки'][index],
        folderId: null,
        updatedAt: 1795260000 - index * 1000,
      })),
      folders: [{ id: 10, name: 'Работа', count: 2 }],
      sections: [{ folderId: null, total: 100, loaded: 4, hasMore: true, loading: false }],
      view: 'home',
      activeChatId: 1,
      messages: [],
      messagesLoading: false,
      hasOlderMessages: false,
      olderMessagesLoading: false,
      sending: false,
      canSend: true,
      attachmentCount: 0,
      query: '',
      loading: false,
      locale: 'ru',
      dark: true,
      palette: { ...profile.dark, surface: profile.dark.surface },
      labels: {
        newChat: 'Новый чат',
        allChats: 'Все чаты',
        settings: 'Настройки',
        search: 'Найти разговор',
        loadMore: 'Загрузить ещё',
        loading: 'Загрузка',
        empty: 'Нет разговоров',
      },
    };
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        (await preview.contents.executeJavaScript(
          'document.querySelectorAll(".channel").length',
        )) === 4,
    );
    assert.deepEqual(
      await preview.contents.executeJavaScript(
        '[typeof chatter,typeof electronAPI,typeof require,typeof process]',
      ),
      ['object', 'undefined', 'undefined', 'undefined'],
    );
    assert.notEqual(preview.contents.getOSProcessId(), host.webContents.getOSProcessId());
    const actions = () =>
      events
        .filter((event) => event.channel === 'interactive-preview:appearance-action')
        .map((event) => event.value.action);
    const place = (width) =>
      manager.place(host.webContents, {
        id: preview.id,
        visible: true,
        bounds: { x: 0, y: 40, width, height: 730 },
        clip: { x: 0, y: 40, width, height: 730 },
      });
    for (const width of [1100, 390, 320]) {
      place(width);
      await sleep(80);
      const metrics = await preview.contents.executeJavaScript(
        '({width:innerWidth,scroll:document.documentElement.scrollWidth})',
      );
      assert.ok(metrics.scroll <= metrics.width, JSON.stringify(metrics));
      const overlap = await preview.contents.executeJavaScript(`(() => {
      const boxes = [...document.querySelectorAll('.map .channel')].map(node => node.getBoundingClientRect());
      return boxes.some((a,i) => boxes.slice(i+1).some(b =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
    })()`);
      assert.equal(overlap, false, 'channels must remain independently clickable');
    }
    place(1100);
    await sleep(120);
    if (process.env.CHATTER_SHELL_SCREENSHOT_DIR) {
      // Paint the same source in an offscreen window. Hidden WebContentsViews
      // exercise DOM/IPC but Windows does not composite their capturePage output.
      offscreen = new BrowserWindow({
        show: false,
        width: 1100,
        height: 730,
        webPreferences: {
          offscreen: true,
            backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      let painted;
      offscreen.webContents.on('paint', (_event, _rect, image) => {
        if (!image.isEmpty()) painted = image;
      });
      offscreen.webContents.setFrameRate(10);
      const fixture = JSON.stringify({
        ...state,
        messages: [
          {
            id: 1,
            role: 'user',
            content: 'Хочу спокойную тему с ощущением северного сияния.',
            createdAt: 1795260000,
          },
          {
            id: 2,
            role: 'assistant',
            content:
              'Пусть свет медленно движется вдоль верхней границы окна. У сообщений — мягкие края и много пространства. Когда приходит ответ, свечение на секунду становится чуть заметнее.',
            createdAt: 1795260001,
          },
        ],
      }).replace(/</g, '\\u003c');
      await offscreen.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<!doctype html><meta charset="utf-8"><script>const snapshot=' +
              fixture +
              ';window.chatter={subscribe(fn){window.updateShell=fn;fn(snapshot)},openChat(id){snapshot.activeChatId=id;snapshot.view="conversation";window.updateShell(snapshot)}};</script>' +
              profile.shell.files[profile.shell.entry],
          ),
      );
      await until(() => painted, 'Offscreen shell did not paint');
      await sleep(150);
      fs.writeFileSync(
        path.join(process.env.CHATTER_SHELL_SCREENSHOT_DIR, 'shell-map.png'),
        painted.toPNG(),
      );
      painted = null;
      await offscreen.webContents.executeJavaScript('document.querySelector(".channel").click()');
      await until(() => painted, 'Conversation did not paint');
      await sleep(100);
      fs.writeFileSync(
        path.join(process.env.CHATTER_SHELL_SCREENSHOT_DIR, 'shell-conversation.png'),
        painted.toPNG(),
      );
      offscreen.destroy();
      offscreen = null;
    }
    await preview.contents.executeJavaScript('chatter.openChat(999)');
    await sleep(80);
    assert.equal(actions().length, 0, 'only published chat IDs are allowed');
    manager.updateAppearanceState(stranger.webContents, preview.id, { ...state, chats: [] });
    await sleep(80);
    assert.equal(
      await preview.contents.executeJavaScript('document.querySelectorAll(".channel").length'),
      4,
    );

    await preview.contents.executeJavaScript('document.querySelector(".channel").click()');
    await until(() => actions().some((action) => action.type === 'openChat' && action.id === 1));
    state.view = 'conversation';
    state.messages = [
      { id: 1, role: 'user', content: 'Привет', createdAt: 1795260000 },
      { id: 2, role: 'assistant', content: 'Первый ответ', createdAt: 1795260001 },
      { id: 3, role: 'assistant', content: '', createdAt: 1795260002 },
    ];
    state.sending = true;
    state.canSend = false;
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        (await preview.contents.executeJavaScript(
          'document.querySelectorAll(".message").length',
        )) === 2,
    );
    assert.equal(
      await preview.contents.executeJavaScript('document.querySelectorAll(".typing").length'),
      1,
    );

    await preview.contents.executeJavaScript(
      'window.previousMessage=document.querySelector(".message")',
    );
    state.messages[1].content += ' и продолжение';
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        await preview.contents.executeJavaScript(
          'document.querySelectorAll(".message .body")[1].textContent.includes("продолжение")',
        ),
    );
    assert.equal(
      await preview.contents.executeJavaScript(
        'window.previousMessage===document.querySelector(".message")',
      ),
      true,
      'stream updates must keep existing message DOM',
    );
    state.sending = false;
    state.canSend = true;
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        await preview.contents.executeJavaScript('!document.getElementById("draft").disabled'),
    );
    assert.equal(
      await preview.contents.executeJavaScript('chatter.sendMessage("Automatic submission")'),
      false,
      'shell code cannot send messages without a real user interaction',
    );
    // Hidden windows cannot receive OS focus. Grant transient user activation in the
    // preload world using Electron, then exercise the real shell form and IPC.
    await preview.contents.executeJavaScriptInIsolatedWorld(999, [{ code: 'void 0' }], true);
    await preview.contents.executeJavaScript(
      'document.getElementById("draft").value="Сообщение из оболочки";document.getElementById("composer").onsubmit({preventDefault(){}})',
      true,
    );
    await until(
      () => actions().some((action) => action.type === 'sendMessage'),
      'Activated shell form produced no action',
    );
    assert.deepEqual(
      actions().find((action) => action.type === 'sendMessage'),
      { type: 'sendMessage', chatId: 1, text: 'Сообщение из оболочки' },
    );
    await preview.contents.executeJavaScript('document.getElementById("native").click()');
    await until(() => actions().some((action) => action.type === 'openConversation'));
    await preview.contents.executeJavaScript('document.getElementById("back").click()');
    await until(() => actions().some((action) => action.type === 'home'));
    state.view = 'home';
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        await preview.contents.executeJavaScript('!document.getElementById("archive").hidden'),
    );
    assert.equal(
      await preview.contents.executeJavaScript('document.getElementById("conversation").hidden'),
      true,
      'returning from native actions must show the custom home, not its previous conversation',
    );
    await preview.contents.executeJavaScript('document.getElementById("more").click()');
    await until(() =>
      actions().some((action) => action.type === 'loadMore' && action.folderId === null),
    );
    state.chats = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      title: 'Очень длинное название разговора '.repeat(4) + index,
      folderId: null,
      updatedAt: 1795260000 - index,
    }));
    state.sections[0] = { folderId: null, total: 200, loaded: 200, hasMore: false, loading: false };
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        (await preview.contents.executeJavaScript(
          'document.querySelectorAll(".channel").length',
        )) === 200,
    );
    assert.equal(
      await preview.contents.executeJavaScript(
        'document.getElementById("archive-scroll").scrollHeight>document.getElementById("archive-scroll").clientHeight',
      ),
      true,
    );
    assert.equal(
      await preview.contents.executeJavaScript('document.getElementById("more").hidden'),
      true,
    );
    state.chats[0].title = '<img src=x onerror=alert(1)>';
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await sleep(80);
    assert.equal(
      await preview.contents.executeJavaScript('document.querySelector(".channel img")'),
      null,
    );
    assert.ok(
      await preview.contents.executeJavaScript(
        'document.querySelector(".channel strong").textContent.includes("<img")',
      ),
    );
    manager.stop(host.webContents, preview.id);
    preview = create(
      'import ReactMarkdown from "react-markdown"; export default function App(){return <ReactMarkdown>{"**Different shell**"}</ReactMarkdown>}',
      'tsx',
    );
    manager.updateAppearanceState(host.webContents, preview.id, state);
    await until(
      async () =>
        (await preview.contents.executeJavaScript(
          'document.querySelector("strong")?.textContent',
        )) === 'Different shell',
    );
    manager.stop(host.webContents, preview.id);

    const fixtureChats = [
      { id: 1, title: 'Северное сияние', folderId: null, updatedAt: 1795260000 },
      { id: 2, title: 'Сжатие видео', folderId: 10, updatedAt: 1795259000 },
      { id: 3, title: 'Идеи на выходные', folderId: null, updatedAt: 1795258000 },
      { id: 4, title: 'Рабочие заметки', folderId: 10, updatedAt: 1795257000 },
    ];
    const exampleState = {
      ...state,
      view: 'home',
      chats: fixtureChats,
      query: '',
      sending: false,
      canSend: true,
      messages: [
        {
          id: 1,
          role: 'user',
          content: 'Давай обсудим следующую версию приложения.',
          createdAt: 1795260000,
        },
        {
          id: 2,
          role: 'assistant',
          content:
            '**Начнём с главного.**\n\nДадим каждому рабочему пространству собственный характер и сохраним привычные действия.\n\n- Разговоры всегда под рукой.\n- Черновик сохраняется при переключении чатов.',
          createdAt: 1795260001,
        },
      ],
    };
    for (const exampleName of ['journal', 'worktable']) {
      const sample = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../examples/appearances/' + exampleName + '.json'),
          'utf8',
        ),
      );
      assert.equal(
        sample.shell.files[sample.shell.entry],
        fs.readFileSync(
          path.resolve(__dirname, '../../examples/appearances/' + exampleName + '.tsx'),
          'utf8',
        ),
      );
      preview = create(sample.shell.files[sample.shell.entry], 'tsx');
      exampleState.view = 'home';
      manager.updateAppearanceState(host.webContents, preview.id, structuredClone(exampleState));
      await until(
        async () =>
          (await preview.contents.executeJavaScript(
            'document.querySelectorAll("[data-chat-id]").length',
          )) === 4,
        exampleName + ' did not render its chat collection',
      );
      for (const width of [1100, 390, 320]) {
        place(width);
        await sleep(60);
        const dimensions = await preview.contents.executeJavaScript(
          '({width:innerWidth,scroll:document.documentElement.scrollWidth})',
        );
        assert.ok(
          dimensions.scroll <= dimensions.width,
          exampleName + ' overflow ' + JSON.stringify(dimensions),
        );
      }
      const actionCount = actions().length;
      await preview.contents.executeJavaScript('document.querySelector("[data-chat-id]").click()');
      await until(() =>
        actions()
          .slice(actionCount)
          .some((action) => action.type === 'openChat'),
      );
      exampleState.view = 'conversation';
      manager.updateAppearanceState(host.webContents, preview.id, structuredClone(exampleState));
      await until(
        async () =>
          await preview.contents.executeJavaScript(
            '!!document.querySelector(".passage strong,.bubble strong")',
          ),
        exampleName + ' did not render Markdown',
      );
      if (exampleName === 'worktable')
        assert.equal(
          await preview.contents.executeJavaScript('document.querySelector("dialog").open'),
          true,
        );
      const processId = preview.contents.getOSProcessId();
      await preview.contents.executeJavaScript('chatter.showHome()');
      await until(() =>
        actions()
          .slice(actionCount)
          .some((action) => action.type === 'home'),
      );
      exampleState.view = 'home';
      manager.updateAppearanceState(host.webContents, preview.id, structuredClone(exampleState));
      await sleep(100);
      assert.equal(
        preview.contents.getOSProcessId(),
        processId,
        'route-aware examples must retain their running UI',
      );
      if (exampleName === 'worktable')
        assert.equal(
          await preview.contents.executeJavaScript('document.querySelector("dialog").open'),
          false,
        );
      else
        assert.equal(
          await preview.contents.executeJavaScript('!!document.querySelector(".home")'),
          true,
        );
      if (process.env.CHATTER_SHELL_SCREENSHOT_DIR) {
        offscreen = new BrowserWindow({
          show: false,
          width: 1100,
          height: 730,
          webPreferences: {
            offscreen: true,
            backgroundThrottling: false,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        let paint;
        offscreen.webContents.on('paint', (_event, _rect, image) => {
          if (!image.isEmpty()) paint = image;
        });
        offscreen.webContents.setFrameRate(10);
        const runtime = fs.readFileSync(
          path.resolve(__dirname, '../dist/interactive/runtime.js'),
          'utf8',
        );
        const { interactiveDocument } = require('../dist/main/interactive-document.js');
        const seed = JSON.stringify(exampleState).replace(/</g, '\\u003c');
        const bridgeScript =
          '<script>const snapshot=' +
          seed +
          ';window.chatter={subscribe(fn){window.updateShell=fn;fn(snapshot);return()=>{}},openChat(id){snapshot.activeChatId=id;snapshot.view="conversation";window.updateShell({...snapshot})},showHome(){snapshot.view="home";window.updateShell({...snapshot})},reportError(){console.error("Sample render failed")}};</script>';
        const document = interactiveDocument(
          {
            language: 'tsx',
            source: sample.shell.files[sample.shell.entry],
            dark: false,
            errorLabel: 'Sample failed',
          },
          runtime,
        ).replace('</head>', bridgeScript + '</head>');
        const screenshotDocument = path.join(directory, exampleName + '-preview.html');
        fs.writeFileSync(screenshotDocument, document);
        await offscreen.loadFile(screenshotDocument);
        await until(
          async () =>
            (await offscreen.webContents.executeJavaScript(
              'document.querySelectorAll("[data-chat-id]").length',
            )) === 4,
        );
        await until(() => paint);
        await sleep(450);
        const homeCapture = await offscreen.webContents.capturePage();
        if (!homeCapture.isEmpty()) paint = homeCapture;
        fs.writeFileSync(
          path.join(process.env.CHATTER_SHELL_SCREENSHOT_DIR, exampleName + '-home.png'),
          paint.toPNG(),
        );
        await offscreen.webContents.executeJavaScript(
          'document.querySelector("[data-chat-id]").click()',
        );
        await until(
          async () =>
            await offscreen.webContents.executeJavaScript(
              '!!document.querySelector(".passage strong,.bubble strong")',
            ),
        );
        await sleep(450);
        const conversationCapture = await offscreen.webContents.capturePage();
        if (!conversationCapture.isEmpty()) paint = conversationCapture;
        fs.writeFileSync(
          path.join(process.env.CHATTER_SHELL_SCREENSHOT_DIR, exampleName + '-conversation.png'),
          paint.toPNG(),
        );
        offscreen.destroy();
        offscreen = null;
      }
      manager.stop(host.webContents, preview.id);
    }
    preview = create(
      '<div id="legacy">Home</div><script>window.chatter.subscribe(s=>{window.data=s});window.visit=()=>document.getElementById("legacy").textContent="Conversation";</script>',
    );
    exampleState.view = 'conversation';
    manager.updateAppearanceState(host.webContents, preview.id, structuredClone(exampleState));
    await until(
      async () => (await preview.contents.executeJavaScript('typeof window.visit')) === 'function',
    );
    await preview.contents.executeJavaScript('window.visit()');
    exampleState.view = 'home';
    manager.updateAppearanceState(host.webContents, preview.id, structuredClone(exampleState));
    await until(
      async () =>
        (await preview.contents.executeJavaScript(
          'document.getElementById("legacy")?.textContent',
        )) === 'Home',
      'previously imported source must return to its own home',
    );
    assert.equal(await preview.contents.executeJavaScript('window.data.view'), 'home');
    manager.stop(host.webContents, preview.id);

    preview = create('export default function App(){ throw new Error("broken") }', 'tsx');
    await until(
      () => !host.contentView.children.length,
      'a broken shell must release its native surface',
    );
    assert.ok(
      events.some(
        (event) =>
          event.channel === 'interactive-preview:status' &&
          event.value.id === preview.id &&
          event.value.phase === 'failed',
      ),
    );
    assert.equal(await host.webContents.executeJavaScript('2+2'), 4);
    console.log(
      'PASS: arbitrary HTML/TSX shells, live state, narrow owned IPC, real-gesture sending, 320px layout, 200 chats, stable streamed messages, empty-answer suppression and failure recovery',
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    manager?.destroy();
    host?.destroy();
    stranger?.destroy();
    offscreen?.destroy();
    app.exit(process.exitCode ?? 0);
  });
