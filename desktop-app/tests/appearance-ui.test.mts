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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-appearance-ui-'));
const modulePath = (file: string) =>
  JSON.stringify(path.resolve(desktopRoot, 'src/renderer', file).replaceAll('\\', '/'));

const authModule = String.raw`
import React from 'react';
export const TestAuth=React.createContext(null);
export const useAuth=()=>React.useContext(TestAuth);
`;
const apiModule = String.raw`
import { parseAppearanceProfile } from ${modulePath('lib/appearance-schema.ts')};
export const API_BASE='test-server';
export const resolveAuthenticatedAssetUrl=(url)=>url;
export const apiFetch=async(path,options)=>{
 await new Promise(resolve=>setTimeout(resolve,5));
 const userId=window.testAccount;
 const current=window.testDb[userId]??{version:1,revision:0,activeId:null,profiles:[]};
 if(!options)return {appearance:structuredClone(current)};
 if(window.failSave){window.failSave=false;throw {data:{error:'appearance_conflict'}};}
 const command=JSON.parse(options.body);
 if(command.action==='save'){
  const profile=parseAppearanceProfile(command.profile),previous=current.profiles.find(p=>p.id===profile.id);
  profile.revision=(previous?.revision??0)+1;
  current.profiles=previous?current.profiles.map(p=>p.id===profile.id?profile:p):[...current.profiles,profile];
  if(command.apply)current.activeId=profile.id;
 }else if(command.action==='activate')current.activeId=command.id;
 else if(command.action==='delete'){current.profiles=current.profiles.filter(p=>p.id!==command.id);if(current.activeId===command.id)current.activeId=null;}
 current.revision++;window.testDb[userId]=current;
 return {appearance:structuredClone(current)};
};
`;
const fixture = String.raw`
import React,{useState,useRef,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createInstance} from 'i18next';
import {I18nextProvider} from 'react-i18next';
import {TestAuth} from 'test-auth';
import {AppearancePanel} from ${modulePath('components/AppearancePanel.tsx')};
import {AppearanceController} from ${modulePath('components/AppearanceController.tsx')};
import {AppearanceConfirmation} from ${modulePath('components/AppearanceConfirmation.tsx')};
import {newAppearance} from ${modulePath('lib/appearance-schema.ts')};
import {previewAppearance,animateMessageArrival} from ${modulePath('lib/appearance-runtime.ts')};
import {appearanceColors,contrastRatio} from ${modulePath('lib/appearance-colors.ts')};
import {ToolActivityCall} from ${modulePath('components/ToolActivity.tsx')};
import {ReasoningDisclosure} from ${modulePath('components/ReasoningDisclosure.tsx')};
import {useMessageArrival} from ${modulePath('lib/use-message-arrival.ts')};
import {ChatComposerDock} from ${modulePath('components/ChatComposerDock.tsx')};
import {ConfirmationCard} from ${modulePath('components/ConfirmationCard.tsx')};
import {ChatMessagesScroll} from ${modulePath('components/ChatMessagesScroll.tsx')};
import {VirtualMessage} from ${modulePath('components/VirtualMessage.tsx')};
import {MarkdownRenderer} from ${modulePath('components/MarkdownRenderer.tsx')};
import {setThemePreference} from ${modulePath('lib/theme.ts')};
import ru from ${modulePath('i18n/locales/ru/translation.json')};
import chat from ${modulePath('pages/ChatPage.module.scss')};
import ${modulePath('global.scss')};
window.newAppearance=newAppearance;window.previewAppearance=previewAppearance;window.appearanceColors=appearanceColors;window.contrastRatio=contrastRatio;window.light=()=>setThemePreference("light");
window.messageViewport=()=>document.querySelector('.'+chat.messages);
window.testAccount=1;window.testDb={};window.animationCount=0;
const nativeAnimate=Element.prototype.animate;
Element.prototype.animate=function(...args){if(this.hasAttribute('data-message-id'))window.animationCount++;return nativeAnimate.apply(this,args);};
function Conversation(){
 const [items,setItems]=useState(()=>Array.from({length:60},(_,n)=>({id:n+1,content:'# Message '+(n+1)+'\n\n'+Array.from({length:12},()=> 'A paragraph with **formatting** and words to wrap.').join('\n\n')})));
 const [chatId,setChatId]=useState(1),[extra,setExtra]=useState("none");window.setComposerExtra=setExtra;
 useMessageArrival(items,chatId,true);
 const ref=useRef(null);window.scrollRef=ref;
 window.appendMessage=()=>setItems(prev=>[...prev,{id:prev.at(-1).id+1,content:'New message'}]);
 window.prependMessage=()=>setItems(prev=>[{id:-10,content:'Earlier message'},...prev]);
 window.switchChat=()=>setChatId(id=>id+1);
 return <><ChatMessagesScroll ref={ref} className={chat.messages} contentClassName={chat.messagesContent} resetKey={chatId} virtualize>
  {items.map(item=><VirtualMessage id={item.id} key={item.id} revision={item}>
   <div data-message-id={item.id} className={chat.messageGroup}>
    <div className={chat.messageIdentity}><span>Vega</span><span className={chat.messageTime}>23:11</span></div>
    <ReasoningDisclosure content="Reasoning text" streaming={false} open={false} onToggle={()=>{}} tokens={141}/>
    <ToolActivityCall call={{id:'search-'+item.id,name:'search_web',arguments:{query:'Interface design'},result_preview:'Done'}}/>
    <div className={item.id%2?chat.bubbleText:chat.bubbleUser}><MarkdownRenderer content={item.content}/></div>
   </div>
  </VirtualMessage>)}
 </ChatMessagesScroll><ChatComposerDock><div className={chat.composerWrap}>
 {extra==='image'&&<div className={chat.imagePreviews}><div style={{height:56,width:56}}>Image</div></div>}
 <div className={chat.composerBody}><div className={chat.composerReview}>
 {(extra==='card'||extra==='large')&&<ConfirmationCard id="dock-check" title="Confirmation" actions={<button>Apply</button>}><div style={{height:extra==='large'?1200:120}}>Review</div></ConfirmationCard>}
 </div><div className={chat.inputArea}><textarea aria-label="Dock input" rows={2}/><button>Send</button></div></div>
 <div className={chat.composerFootnote}>Enter to send</div></div></ChatComposerDock></>;

}
function App(){
 const [user,setUser]=useState({id:1,ui_settings:{}}),[proposal,setProposal]=useState(null);
 window.changeAccount=()=>{window.testAccount=2;setUser({id:2,ui_settings:{}});};
 window.propose=()=>setProposal({proposal_id:'bot-proposal',profile:{...newAppearance('from-bot'),name:'Bot look'}});
 window.proposeDraft=()=>setProposal({proposal_id:'bot-draft',profile:{...newAppearance('saved-bot'),name:'Saved bot draft'}});
 window.motionPreview=()=>previewAppearance({...newAppearance('motion'),motion:{preset:'custom',duration:100,distance:12,scale:0.97,easing:'ease-out'}});
 window.dark=()=>{setThemePreference('dark');window.dispatchEvent(new CustomEvent('chatter-theme-change',{detail:'dark'}));};
 return <TestAuth.Provider value={{user,setUser}}><AppearanceController/>
  <div id="panel-fixture" className={chat.sidebar} style={{width:'48%',height:'100%',overflow:'auto',padding:20}}><AppearancePanel/>{proposal&&<AppearanceConfirmation proposal={proposal} onResolved={()=>setProposal(null)}/>}</div>
  <div className={chat.main} style={{width:'52%',height:'100%',display:'flex',flexDirection:'column'}}><Conversation/></div>
 </TestAuth.Provider>;
}
window.clickText=text=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text&&!el.disabled&&el.getBoundingClientRect().height>0);if(!button)throw new Error('Button missing: '+text);button.click();};
window.inputText=(label,value)=>{
 const input=document.querySelector('input[aria-label="'+label+'"]')??[...document.querySelectorAll('label')].find(el=>el.textContent.trim()===label)?.querySelector('input');
 if(!input)throw new Error('Input missing: '+label);
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
 input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
};
const i18n=createInstance();
i18n.init({lng:'ru',resources:{ru:{translation:ru}},interpolation:{escapeValue:false}}).then(()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><I18nextProvider i18n={i18n}><App/></I18nextProvider></QueryClientProvider>);
 window.fixtureReady=true;
});
`;

const electronFixture = String.raw`
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'user-data'));
setTimeout(()=>{console.error('Appearance UI timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,useContentSize:true,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 const wc=win.webContents,errors=[];
 wc.on('console-message',(_event,level,message)=>{if(level===3)errors.push(message);});
 wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,cb)=>cb({cancel:true}));
 const js=async code=>{try{return await wc.executeJavaScript(code);}catch(error){console.error('Failed JS:',code);console.error('Renderer errors:',errors);throw error;}},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async code=>{for(let n=0;n<120;n++){if(await js(code))return;await sleep(25);}throw new Error('Timed out: '+code);};
 await win.loadFile(path.join(__dirname,'renderer/index.html'));
 await until('window.fixtureReady && [...document.querySelectorAll("button")].some(el=>el.textContent==="Создать оформление")');
 await until('document.querySelectorAll("[data-virtual-row-placeholder]").length>30');
 // The floating dock must reserve space without shrinking or recoloring the viewport.
 const dockMetrics=()=>js('(()=>{const v=window.messageViewport(),dock=document.querySelector("[data-chat-composer-dock]"),input=dock.querySelector("textarea"),last=[...document.querySelectorAll("[data-message-id]")].at(-1);return {height:v.clientHeight,bottom:v.getBoundingClientRect().bottom,dockTop:dock.getBoundingClientRect().top,inputBottom:input.getBoundingClientRect().bottom,reserve:parseFloat(v.parentElement.style.getPropertyValue("--chat-composer-height")),lastBottom:last.getBoundingClientRect().bottom,background:getComputedStyle(v).backgroundImage};})()');
 await until('parseFloat(window.messageViewport().parentElement.style.getPropertyValue("--chat-composer-height"))>0');
 const initialDock=await dockMetrics();
 for(const kind of ['image','card','large','none']){
  await js('window.setComposerExtra('+JSON.stringify(kind)+')');
  await until('Math.abs(parseFloat(window.messageViewport().parentElement.style.getPropertyValue("--chat-composer-height"))-document.querySelector("[data-chat-composer-dock]").getBoundingClientRect().height)<1');
  await sleep(100);
  const next=await dockMetrics();assert.equal(next.height,initialDock.height,'extras must not shrink message viewport');
  assert.ok(next.inputBottom<=next.bottom,'input remains visible even with a large confirmation');
  assert.ok(next.lastBottom<=next.dockTop+1,'last message remains above floating composer '+kind+' '+JSON.stringify(next));
  assert.equal(next.background,initialDock.background);
 }
 const originalHeight=await js('window.scrollRef.current.getMetrics().scrollHeight');
 await js('window.clickText("Создать оформление")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.inputText("Название","My evening");window.inputText("Размер сообщений",22);window.inputText("Шрифт сообщений","Georgia");window.inputText("Плотность",1.2)');
 await js('window.clickText("Сохранить вариант")');
 await until('window.testDb[1]?.profiles.length===1');
 assert.equal(await js('document.documentElement.dataset.appearance??null'),null,'saving a variant must not activate it');
 assert.equal(await js('window.testDb[1].activeId'),null);
 await js('window.clickText("Изменить")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.inputText("Название","Preview change");window.clickText("Предпросмотр")');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 assert.equal(await js('window.testDb[1].profiles[0].name'),'My evening','preview must not mutate stored data');
 await until('window.scrollRef.current.getMetrics().scrollHeight>'+originalHeight);
 const type=await js('(()=>{const md=document.querySelector("[data-message-id] h1").parentElement;return {font:getComputedStyle(md).fontFamily,size:getComputedStyle(md).fontSize};})()');
 assert.ok(type.font.includes('Georgia'));assert.equal(type.size,'22px');
 await js('window.clickText("Вернуть оформление")');
 await until('!document.documentElement.dataset.appearance');
 await until('Math.abs(window.scrollRef.current.getMetrics().scrollHeight-'+originalHeight+')<=2');
 // Apply from the recovery bar: the editor must resolve rather than keep a stale revision.
 await js('window.clickText("Предпросмотр")');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 await js('(()=>{const bar=document.querySelector("[aria-label=Предпросмотр]");[...bar.querySelectorAll("button")].find(el=>el.textContent==="Сохранить и применить").click();})()');
 await until('window.testDb[1].activeId!==null && !document.querySelector("input[list=appearance-fonts]")');
 await js('window.dark()');
 assert.equal(await js('document.documentElement.style.getPropertyValue("--bg-secondary")'),'#101722');
 // A bot proposal follows the same preview/apply flow and disappears when applied from the bar.
 await js('window.propose()');
 await until('!!document.querySelector("[data-confirmation-id=bot-proposal]") || document.body.textContent.includes("Bot look")');
 await js('window.clickText("Предпросмотр")');
 await until('!!document.querySelector("[aria-label=Предпросмотр]")');
 await js('(()=>{const bar=document.querySelector("[aria-label=Предпросмотр]");[...bar.querySelectorAll("button")].find(el=>el.textContent==="Сохранить и применить").click();})()');
 await until('window.testDb[1].activeId==="from-bot" && !document.body.textContent.includes("Предложение оформления")');
 await js('window.proposeDraft()');
 await until('document.body.textContent.includes("Saved bot draft")');
 await js('window.clickText("Сохранить вариант")');
 await until('window.testDb[1].profiles.length===3 && !document.body.textContent.includes("Предложение оформления")');
 assert.equal(await js('window.testDb[1].activeId'),'from-bot','saving a bot variant must not change active appearance');
 // Set each region through the real editor, preview without saving, and reset to Auto.
 await js('window.light();window.clickText("Изменить")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.inputText("Светлая палитра Панели и окна","#081a2b");window.inputText("Светлая палитра Однотонный фон переписки","#253443");window.clickText("Предпросмотр")');
 await until('document.documentElement.dataset.appearancePanels==="custom"');
 assert.equal(await js('getComputedStyle(document.querySelector("#panel-fixture")).backgroundColor'),'rgb(8, 26, 43)');
 assert.equal(await js('getComputedStyle(window.messageViewport()).backgroundColor'),'rgb(37, 52, 67)');
 assert.notEqual(await js('getComputedStyle(document.body).color'),await js('getComputedStyle(document.querySelector("#panel-fixture")).color'));
 await js('[...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")==="Светлая палитра Панели и окна Авто").click()');
 await until('!document.documentElement.dataset.appearancePanels');
 await js('window.clickText("Вернуть оформление");window.clickText("Отмена")');
 // Reproduce a dark Mass Effect gradient while the shell remains light.
 await js('window.light();window.previewAppearance({...window.newAppearance("contrast"),typography:{...window.newAppearance().typography,uiSize:18},geometry:{radius:0,density:1.2},background:{...window.newAppearance().background,type:"gradient",color:"#04101e",color2:"#12365a"}})');
 await until('document.documentElement.dataset.appearance==="contrast"');
 const contrast=await js('(()=>{const hex=rgb=>"#"+rgb.match(/\\d+/g).slice(0,3).map(n=>Number(n).toString(16).padStart(2,"0")).join("");const row=document.querySelector("[data-message-id]");const heading=row.querySelector("h1"),summary=row.querySelector("summary"),reasoning=row.querySelector("button"),md=heading.parentElement;return {body:hex(getComputedStyle(md).color),hint:getComputedStyle(reasoning).color,shell:getComputedStyle(document.body).color,tool:hex(getComputedStyle(summary).color),toolBg:hex(getComputedStyle(summary).backgroundColor),radius:getComputedStyle(summary).borderRadius,size:getComputedStyle(summary.parentElement).fontSize,backdrop:getComputedStyle(window.messageViewport()).backgroundImage};})()');
 assert.ok(await js('window.contrastRatio('+JSON.stringify(contrast.body)+',"#04101e")>=4.5 && window.contrastRatio('+JSON.stringify(contrast.body)+',"#12365a")>=4.5'),'message ink must contrast with both gradient stops');
 assert.ok(await js('window.contrastRatio('+JSON.stringify(contrast.tool)+','+JSON.stringify(contrast.toolBg)+')>=4.5'),'tool surface contrast');
 assert.equal(contrast.radius,'0px','work log tool corners follow appearance');
 assert.ok(Math.abs(parseFloat(contrast.size)-12*18/14)<0.01,'work log font size follows interface size');
 assert.notEqual(contrast.hint,contrast.shell,'reasoning must inherit the chat palette rather than the light shell');
 await sleep(250);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-appearance-contrast-light.png'),(await wc.capturePage()).toPNG());
 await js('window.dark()');await sleep(100);
 const darkInk=await js('getComputedStyle(document.querySelector("[data-message-id] h1").parentElement).color');
 assert.notEqual(darkInk,'rgb(15, 29, 48)');
 await js('window.clickText("Вернуть оформление")');
 await until('document.documentElement.dataset.appearance==="from-bot"');
 // Real renderer/editor materials: only surfaces change opacity; text stays fully opaque.
 await js('window.clickText("Изменить")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await js('window.clickText("Настроить материал")');
 await js('window.clickText("Настроить материал")');
 await js('window.clickText("Предпросмотр")');
 await until('document.documentElement.dataset.materialPanels==="custom" && document.documentElement.dataset.materialComposer==="custom"');
 const materialStyle=await js('(()=>{const panel=document.querySelector("#panel-fixture"),input=document.querySelector("[data-chat-composer-dock] textarea"),surface=input.parentElement;return {panelFilter:getComputedStyle(panel).backdropFilter,filter:getComputedStyle(surface).backdropFilter,fill:getComputedStyle(surface).backgroundColor,opacity:getComputedStyle(input).opacity,shadow:getComputedStyle(surface).boxShadow};})()');
 assert.equal(materialStyle.panelFilter,'blur(16px)'); assert.equal(materialStyle.filter,'blur(16px)');
 assert.equal(materialStyle.opacity,'1');assert.notEqual(materialStyle.shadow,'none');assert.ok(materialStyle.fill.startsWith('rgba('));
 await js('[...document.querySelectorAll("h4")].find(el=>el.textContent==="Материалы поверхностей").scrollIntoView({block:"start"});window.scrollRef.current.scrollTo(0,{immediate:true})');
 await sleep(250);await wc.capturePage();await sleep(100);
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-materials-review.png'),(await wc.capturePage()).toPNG());
 await js('window.scrollRef.current.scrollTo("end",{immediate:true})');

 await wc.debugger.attach('1.3');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
 const fallback=await js('getComputedStyle(document.querySelector("[data-chat-composer-dock] textarea").parentElement).backdropFilter');
 assert.equal(fallback,'none');await wc.debugger.detach();
 await js('[...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")==="Поле ввода Авто").click()');
 await until('!document.documentElement.dataset.materialComposer');
 assert.equal(await js('getComputedStyle(document.querySelector("[data-chat-composer-dock] textarea").parentElement).backdropFilter'),'none');
 await js('window.clickText("Вернуть оформление");window.clickText("Отмена")');
 assert.ok(await js('!document.documentElement.dataset.materialComposer && !document.documentElement.dataset.materialPanels'));
 // Animation is tied to append events, never to row remounts or prepending history.
 await js('window.motionPreview()');
 await js('window.appendMessage()');
 await until('window.animationCount===1');
 await js('window.scrollRef.current.scrollTo(0,{immediate:true})');
 await sleep(100);
 await js('window.scrollRef.current.scrollTo("end",{immediate:true})');
 await sleep(100);
 assert.equal(await js('window.animationCount'),1,'virtual row remounts must not replay arrival');
 await js('window.prependMessage()');
 await sleep(100);assert.equal(await js('window.animationCount'),1);
 await js('window.switchChat()');await sleep(100);assert.equal(await js('window.animationCount'),1);
 await wc.debugger.attach('1.3');
 await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await js('window.appendMessage()');await sleep(100);assert.equal(await js('window.animationCount'),1,'reduced motion must suppress arrival');
 await wc.debugger.detach();
 await js('window.motionPreview()');
 await js('window.dispatchEvent(new KeyboardEvent("keydown",{code:"Backspace",key:"Backspace",ctrlKey:true,altKey:true,bubbles:true}))');
 await until('window.testDb[1].activeId===null && !document.documentElement.dataset.appearance');
 // Account changes clear both the selected profile and any unfinished preview.
 await js('window.changeAccount()');
 await until('!document.documentElement.dataset.appearance && !document.querySelector("[aria-label=Предпросмотр]")');
 assert.ok(await js('window.testDb[1].profiles.length===3'));
 assert.deepEqual(errors,[]);
 // Leave a reviewable screenshot of the real catalog/editor.
 await until('[...document.querySelectorAll("button")].some(el=>el.textContent==="Создать оформление"&&!el.disabled)');
 await js('window.clickText("Создать оформление")');
 await until('!!document.querySelector("input[list=appearance-fonts]")');
 await sleep(400);
 await wc.capturePage();await sleep(100);
 const shot=await wc.capturePage();
 fs.writeFileSync(path.join(process.env.TEMP,'chatter-appearance-review.png'),shot.toPNG());
 win.destroy();
 console.log('PASS: actual appearance editor and cards, inactive saves, reversible preview, palette/typography/density, virtual height restoration, applying proposals from recovery bar, arrival-only animation, reduced motion and account isolation');
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
`;
try {
  await build({
    configFile: false,
    root: desktopRoot,
    logLevel: 'error',
    plugins: [
      {
        name: 'appearance-ui-fixture',
        enforce: 'pre',
        resolveId(id: string, importer?: string) {
          if (id === 'test-auth' || id.endsWith('/lib/auth') || id === './auth')
            return '\0test-auth';
          if (
            (id.endsWith('/lib/api') || id === './api') &&
            /AppearancePanel|AppearanceController|appearance-service/.test(importer ?? '')
          )
            return '\0test-api';
          if (id === 'appearance-ui.tsx') return '\0' + id;
        },
        async load(id: string) {
          if (id === '\0test-auth')
            return transformWithEsbuild(authModule, 'auth.tsx', {
              loader: 'tsx',
              jsx: 'automatic',
            });
          if (id === '\0test-api')
            return transformWithEsbuild(apiModule, 'api.ts', { loader: 'ts' });
          if (id === '\0appearance-ui.tsx')
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
        input: 'appearance-ui.tsx',
        output: { entryFileNames: 'entry.js' },
        onwarn(warning: { code?: string }, warn: (warning: unknown) => void) {
          if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
        },
      },
    },
  });
  const css = fs
    .readdirSync(path.join(directory, 'renderer/assets'))
    .find((name) => name.startsWith('_appearance-ui') && name.endsWith('.css'));
  assert.ok(css);
  fs.writeFileSync(
    path.join(directory, 'renderer/index.html'),
    '<meta charset="UTF-8"><link rel="stylesheet" href="./assets/' +
      css +
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
      reject(new Error('Appearance UI fixture timed out'));
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
  assert.ok(path.basename(directory).startsWith('chatter-appearance-ui-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
