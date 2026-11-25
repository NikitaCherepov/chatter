// Isolated runtime integration. Host state/services are fixtures; no user's chats/preferences are touched.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
protocol.registerSchemesAsPrivileged([
  { scheme: INTERACTIVE_SCHEME, privileges: { standard: true, secure: true } },
]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-chat-sdk-'));
app.setPath('userData', directory);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 10000) throw Error('Chat SDK condition timed out');
    await sleep(20);
  }
}
const message = (id, index, content = 'Original') => ({
  id,
  role: 'assistant',
  content,
  createdAt: 1,
  timelineIndex: index,
  archived: index <= 10,
  streaming: false,
  reasoningContent: '',
  workLog: [],
  toolStatus: null,
  variantIndex: 0,
  variantCount: 2,
  actions: ['copy', 'edit', 'regenerate', 'regenerateHint', 'activateVariant', 'speak'],
  images: [{ url: 'https://fixture.invalid/image.png', type: 'generated' }],
  attachments: [
    {
      url: '/one.pdf',
      name: 'one.pdf',
      filename: 'one.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    },
    {
      url: '/two.docx',
      name: 'two.docx',
      filename: 'two.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 10,
    },
  ],
});
let state = {
  scopeId: 'scope-a',
  view: 'conversation',
  activeChatId: 1,
  messages: [message(10, 9), message(11, 11)],
  models: {
    loading: false,
    busy: false,
    error: null,
    selectedId: 'a',
    automaticLabel: 'Auto',
    automaticSupportsVision: true,
    contextLimit: 16000,
    items: [
      { id: 'a', name: 'Model A' },
      { id: 'b', name: 'Model B' },
    ],
    reasoning: {
      label: 'Thinking',
      selectedLevel: null,
      options: [
        { value: null, label: 'Auto' },
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
    },
  },
  voice: { status: 'idle', canStart: true, error: null, transcript: null },
  speech: { messageId: 10, status: 'playing' },
  context: {
    showTokens: false,
    summary: {
      kind: 'summary',
      title: 'Recap',
      content: 'Summary text',
      throughTimelineIndex: 10,
      updatedAt: 1,
    },
  },
  confirmations: [
    {
      id: 'approval',
      title: 'Request',
      summary: 'Fixture request',
      revision: 1,
      ready: true,
      busy: false,
      customizable: true,
      content: [{ type: 'text', text: 'Review fixture' }],
      fields: [
        { id: 'allow', label: 'Allow once', type: 'checkbox', value: false, disabled: false },
      ],
      actions: [
        { id: 'approve', label: 'Approve', disabled: false, group: 'primary', comment: true },
      ],
    },
  ],
  messagesLoading: false,
  hasOlderMessages: true,
  olderMessagesLoading: false,
  canSend: true,
  sending: false,
  attachmentCount: 0,
  composer: {
    busy: false,
    error: null,
    items: [],
    limits: {
      maxImageCount: 10,
      maxImageBytes: 10000,
      maxDocumentBytes: 10000,
      imageFormats: ['image/png'],
      documentExtensions: ['pdf'],
    },
  },
  chats: [
    {
      id: 1,
      title: 'Chat one',
      folderId: 2,
      updatedAt: 1,
      isOwner: true,
      botHidden: false,
      actions: ['rename', 'downloadDocx', 'move', 'setBotHidden', 'delete'],
    },
  ],
  folders: [{ id: 2, name: 'Folder', count: 4, actions: ['rename', 'delete'] }],
  sections: [{ folderId: 2, total: 4, loaded: 1, hasMore: true, loading: false }],
  library: {
    busy: false,
    error: null,
    operation: null,
    canCreateFolder: true,
    limits: { chatTitle: 120, folderName: 80 },
  },
  query: '',
  loading: false,
  locale: 'en',
  dark: false,
  palette: { background: '#fff', text: '#000', surface: '#eee', accent: '#08f' },
  labels: {
    copy: 'Localized copy',
    edit: 'Edit',
    regenerate: 'Regenerate',
    regenerateHint: 'Regenerate with hint',
    speak: 'Speak',
    nextVariant: 'Next',
    renameChat: 'Rename chat',
    delete: 'Delete',
    unfiled: 'Unfiled',
  },
};
const source = `import React from 'react';
import {useChatterState,useComposer,useModels,useConversation,useVoice,useSpeech,useMessage,useMessageEditor,useImageViewer,useDocumentViewer,useDocument,useConfirmations,useConfirmation,useChatLibrary,useChatMenu,useChatEditor,useFolderEditor} from '@chatter/ui';
function Composer({id}){const form=useComposer();window['composer'+id]=form;return <section><textarea id={'text-'+id} {...form.bind()}/><button id={'send-'+id} disabled={!form.canSend} onClick={()=>form.send()}>Send</button></section>;}
function Card({id}){const card=useConfirmation(id);window.card=card;return <section><input id='approval-field' type='checkbox' {...card.bind('allow')}/><button id='approve' onClick={()=>card.run('approve','Reviewed')}>Approve</button></section>;}
export default function App(){
 const chat=useConversation({navigation:true}),models=useModels(),voice=useVoice(),speech=useSpeech(),item=useMessage(10),edit=useMessageEditor(10),
   image=useImageViewer(),document=useDocumentViewer(),a=useDocument(10,0,{enabled:false}),b=useDocument(10,0,{enabled:false}),
   confirmations=useConfirmations(),library=useChatLibrary(),menu=useChatMenu(1),rename=useChatEditor(1),folder=useFolderEditor(null),pending=useMessage(-1),state=useChatterState();
 const [composers,setComposers]=React.useState(true);window.sdk={chat,models,voice,speech,item,edit,image,document,library,menu,rename,folder};
 window.readDocs=()=>Promise.all([a.read(),b.read()]);window.setComposers=setComposers;
 return <main>
 {composers&&<><Composer id='a'/><Composer id='b'/></>}
 <select id='model' {...models.bind()}>{models.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
 <select id='reasoning' {...models.reasoning.bind()}>{models.reasoning.options.map(option=><option key={option.value??'auto'} value={option.value??''}>{option.label}</option>)}</select>
 <output id='timeline'>{chat.timeline.map(item=>item.kind==='summary'?'summary':item.message.id).join(',')}</output>
 <output id='has-body'>{String(item.hasBody)}</output><output id='activity'>{String(item.hasActivity)}</output>
 <output id='pending-body'>{String(pending.hasBody)}</output><output id='pending-activity'>{String(pending.hasActivity)}</output>
 <button id='copy' onClick={item.copy}>Copy</button><button id='speak' onClick={item.speak}>Speak</button>
 <textarea id='edit' {...edit.bind()}/><button id='save-edit' disabled={!edit.canSave} onClick={()=>void edit.save()}>Save edit</button>
 <output id='conflict'>{String(edit.conflict)}</output>
 <button id='doc-one' onClick={()=>document.open(10,0)}>Document one</button><button id='doc-two' onClick={()=>document.open(10,1)}>Document two</button>
 <output id='document'>{document.visible?document.file?.name:''}</output><output id='document-text'>{document.data?.text}</output>
 <output id='page'>{document.renderedPage.data?.page}</output><output id='media-visible'>{String(image.visible||document.visible)}</output>
 <button id='image' onClick={()=>image.open(10,'https://fixture.invalid/image.png')}>Image</button><output id='image-source'>{image.source}</output>
 <output id='image-failed'>{String(image.failed)}</output>
 {confirmations.items.map(card=><Card key={card.id} id={card.id}/>)}
 <input id='search' {...library.bindSearch()}/><output id='menu'>{menu.items.map(item=>item.label).join(',')}</output>
 <input id='rename' {...rename.bind()}/><button id='save-rename' disabled={!rename.canSave} onClick={()=>void rename.save()}>Rename</button>
 <input id='folder' {...folder.bind()}/><button id='save-folder' disabled={!folder.canSave} onClick={()=>void folder.save()}>Create folder</button>
 </main>;
}`;
let host, manager, id, contents;
const actions = [],
  reads = [],
  held = [];
let hold = false;
const push = () => manager.updateAppearanceState(host.webContents, id, state);
app
  .whenReady()
  .then(async () => {
    host = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await host.loadURL('data:text/html,<body>Host fixture</body>');
    manager = new InteractivePreviews();
    const send = host.webContents.send.bind(host.webContents);
    host.webContents.send = (channel, payload) => {
      if (channel === 'interactive-preview:appearance-action') {
        const action = payload.action;
        actions.push(action);
        if (action.type === 'selectModel')
          state = { ...state, models: { ...state.models, selectedId: action.id } };
        if (action.type === 'selectReasoning')
          state = {
            ...state,
            models: {
              ...state.models,
              reasoning: { ...state.models.reasoning, selectedLevel: action.level },
            },
          };
        if (action.type === 'sendMessage') state = { ...state, sending: true, canSend: false };
        if (action.type === 'messageAction' && action.action === 'edit')
          state = {
            ...state,
            messages: state.messages.map((message) =>
              message.id === action.messageId ? { ...message, content: action.text } : message,
            ),
          };
        if (action.type === 'speechAction')
          state = {
            ...state,
            speech: {
              messageId: 10,
              status:
                action.action === 'pause'
                  ? 'paused'
                  : action.action === 'resume'
                    ? 'playing'
                    : 'idle',
            },
          };
        if (action.type === 'confirmationField')
          state = {
            ...state,
            confirmations: state.confirmations.map((card) => ({
              ...card,
              revision: card.revision + 1,
              fields: card.fields.map((field) =>
                field.id === action.fieldId ? { ...field, value: action.value } : field,
              ),
            })),
          };
        if (action.type === 'confirmationAction') state = { ...state, confirmations: [] };
        if (action.type === 'search') state = { ...state, query: action.query };
        if (action.type === 'chatMenuAction' && action.action === 'rename')
          state = {
            ...state,
            chats: state.chats.map((chat) => ({ ...chat, title: action.title })),
          };
        push();
      }
      if (channel === 'interactive-preview:appearance-document') {
        const request = payload.request;
        reads.push(request);
        const result =
          request.method === 'renderAttachmentPage'
            ? {
                page: request.page,
                pageCount: 2,
                source: 'data:image/png;base64,AQID',
                width: 10,
                height: 10,
              }
            : request.index === 0
              ? {
                  kind: 'pdf',
                  name: 'one.pdf',
                  text: 'PDF fixture',
                  pageCount: 2,
                  mimeType: 'application/pdf',
                  sizeBytes: 10,
                }
              : {
                  kind: 'docx',
                  name: 'two.docx',
                  text: 'DOCX fixture',
                  html: '<p>DOCX fixture</p>',
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  sizeBytes: 10,
                };
        const reply = () =>
          manager.resolveAppearanceDocument(host.webContents, id, request.requestId, result);
        if (hold) held.push(reply);
        else reply();
      }
      return send(channel, payload);
    };
    id = manager.create(host.webContents, {
      language: 'tsx',
      source,
      dark: false,
      errorLabel: 'failed',
      bridge: 'appearance-chat-list-v1',
    });
    contents = host.contentView.children.at(-1).children[0].webContents;
    push();
    const js = (code) => contents.executeJavaScript(code),
      click = (selector) =>
        contents.executeJavaScript(
          'document.querySelector(' + JSON.stringify(selector) + ').click()',
          true,
        );
    const text = (selector) =>
      js('document.querySelector(' + JSON.stringify(selector) + ')?.textContent');
    const input = (selector, value) =>
      contents.executeJavaScript(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        true,
      );
    const select = (selector, value) =>
      contents.executeJavaScript(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        true,
      );
    await until(async () => await js('!!window.sdk&&!!document.querySelector("#text-a")'));
    assert.equal(
      await text('#timeline'),
      '10,summary,11',
      'recap appears at its boundary even with hidden token counters',
    );
    await input('#text-a', 'Draft');
    await until(async () => (await js('document.querySelector("#text-b").value')) === 'Draft');
    state = { ...state, voice: { ...state.voice, transcript: { id: 1, text: 'voice' } } };
    push();
    await until(
      async () => (await js('document.querySelector("#text-a").value')) === 'Draft voice',
    );
    assert.equal(await js('document.querySelector("#text-b").value'), 'Draft voice');
    await js('window.setComposers(false)');
    await until(async () => !(await js('!!document.querySelector("#text-a")')));
    await js('window.setComposers(true)');
    await until(
      async () => (await js('document.querySelector("#text-a")?.value')) === 'Draft voice',
    );
    await click('#send-a');
    await until(() => actions.some((action) => action.type === 'sendMessage'));
    assert.equal(actions.filter((action) => action.type === 'sendMessage').length, 1);
    assert.equal(await js('window.composera.text'), '');
    state = {
      ...state,
      sending: false,
      canSend: true,
      voice: { ...state.voice, transcript: null },
    };
    push();
    await select('#model', 'b');
    await until(() => state.models.selectedId === 'b');
    await select('#reasoning', 'high');
    await until(() => state.models.reasoning.selectedLevel === 'high');
    assert.equal(
      actions.filter((action) => action.type === 'selectReasoning').at(-1).level,
      'high',
    );
    await select('#reasoning', '');
    await until(() => state.models.reasoning.selectedLevel === null);
    await click('#copy');
    await until(() =>
      actions.some((action) => action.type === 'messageAction' && action.action === 'copy'),
    );
    await click('#speak');
    await until(() => state.speech.status === 'paused');
    await click('#speak');
    await until(() => state.speech.status === 'playing');
    await input('#edit', 'Edited');
    await until(async () => !(await js('document.querySelector("#save-edit").disabled')));
    await click('#save-edit');
    await until(() => state.messages[0].content === 'Edited');
    await input('#edit', 'Local draft');
    state = {
      ...state,
      messages: state.messages.map((message) =>
        message.id === 10 ? { ...message, content: 'Changed elsewhere' } : message,
      ),
    };
    push();
    await until(async () => (await text('#conflict')) === 'true');
    assert.equal(await js('document.querySelector("#edit").value'), 'Local draft');
    await js('window.oldEdit=window.sdk.item.edit;void 0');
    state = {
      ...state,
      messages: state.messages.map((message) =>
        message.id === 10 ? { ...message, variantIndex: 1 } : message,
      ),
    };
    push();
    await until(async () => (await js('window.sdk.item.message.variantIndex')) === 1);
    assert.equal(await js('window.oldEdit("Wrong variant")'), false);
    const readResults = await js('window.readDocs()');
    assert.equal(readResults[0].ok, true);
    assert.equal(readResults[1].ok, true);
    assert.equal(
      reads.filter((request) => request.method === 'readAttachment' && request.index === 0).length,
      1,
      'readers share a single document request',
    );
    await click('#doc-one');
    await until(async () => (await text('#document-text')) === 'PDF fixture');
    await until(async () => (await text('#page')) === '1');
    await js('window.sdk.document.setPage(2)');
    await until(async () => (await text('#page')) === '2');
    hold = true;
    await click('#doc-two');
    await until(() => held.length === 1);
    await click('#doc-one');
    hold = false;
    held.splice(0).forEach((reply) => reply());
    await sleep(80);
    assert.equal(await text('#document'), 'one.pdf');
    assert.equal(
      await text('#document-text'),
      'PDF fixture',
      'late previous-target reads never replace the current viewer',
    );
    await click('#image');
    await until(async () => await text('#image-source'));
    assert.equal(
      new URL(await text('#image-source')).searchParams.get('width'),
      '0',
      'custom viewer receives full-resolution source',
    );
    await js('window.sdk.image.onError()');
    await until(async () => (await text('#image-failed')) === 'true');
    await js('window.sdk.image.retry()');
    await until(async () => (await text('#image-failed')) === 'false');
    await js('window.oldDecision=window.card.run;void 0');
    assert.equal(await js('window.card.run("approve","")'), false);
    assert.equal(
      await contents.executeJavaScript(
        'document.querySelector("#approval-field").click();window.card.run("approve","Too early")',
        true,
      ),
      false,
      'a decision is blocked synchronously before a field echo, even with an old callback',
    );
    await until(() => state.confirmations[0].revision === 2);
    await until(async () => (await js('window.card.waiting')) === false);
    assert.equal(await js('window.oldDecision("approve","Stale")'), false);
    await click('#approve');
    await until(() => state.confirmations.length === 0);
    assert.equal(actions.filter((action) => action.type === 'confirmationAction').length, 1);
    await input('#search', 'words');
    await until(() => state.query === 'words');
    assert.match(await text('#menu'), /Rename chat/);
    assert.equal(await js('window.sdk.menu.remove(false)'), false);
    await input('#rename', 'Renamed');
    await until(async () => !(await js('document.querySelector("#save-rename").disabled')));
    await click('#save-rename');
    await until(() => state.chats[0].title === 'Renamed');
    await input('#folder', 'Created folder');
    await until(async () => !(await js('document.querySelector("#save-folder").disabled')));
    await click('#save-folder');
    await until(() =>
      actions.some(
        (action) =>
          action.type === 'folderMenuAction' &&
          action.action === 'create' &&
          action.name === 'Created folder',
      ),
    );
    await input('#text-a', 'Account A draft');
    await js('window.oldComposer=window.composera;window.oldModels=window.sdk.models;void 0');
    state = {
      ...state,
      scopeId: 'scope-b',
      activeChatId: 2,
      messages: [],
      voice: { ...state.voice, transcript: null },
    };
    push();
    await until(async () => (await js('document.querySelector("#text-a").value')) === '');
    assert.equal(await js('window.oldComposer.setText("Leak")'), false);
    assert.equal(await js('window.oldModels.select("a")'), false);
    assert.equal(
      await text('#media-visible'),
      'false',
      'account/chat changes invalidate custom viewers',
    );
    state = {
      ...state,
      activeChatId: 1,
      messages: [
        {
          ...message(-1, 12, ''),
          images: [],
          attachments: [],
          streaming: true,
          reasoningContent: 'Thinking',
        },
      ],
    };
    push();
    await until(async () => (await text('#pending-activity')) === 'true');
    assert.equal(
      await text('#pending-body'),
      'false',
      'reasoning alone must not produce an empty bubble',
    );
    console.log(
      'PASS: real headless SDK shared drafts/remounts/transcripts, model+reasoning controls, message edits/conflicts/variants, document dedup/PDF paging/stale viewers, full image retry, confirmation revisions, library forms and account isolation',
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    manager?.destroy();
    host?.destroy();
    app.exit(process.exitCode ?? 0);
  });
