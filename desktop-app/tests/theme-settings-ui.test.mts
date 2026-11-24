import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const desktop = path.join(root, 'desktop-app'), require = createRequire(path.join(desktop, 'package.json'));
const { build, transformWithEsbuild } = require('vite');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-theme-settings-'));
const modulePath = (name: string) => JSON.stringify(path.join(desktop, 'src/renderer', name).replaceAll('\\', '/'));
const native = fs.readFileSync(path.join(desktop, 'src/renderer/components/SettingsModal.tsx'), 'utf8');
const nativeFlags = native.slice(native.indexOf('  const handleToggleShowTokens ='), native.indexOf('  const handleSubagentModelChange ='));
const apiSource = `
export const API_BASE='fixture';
export const getUiSettings=async()=>{const user=window.testAccount;if(window.delaySettingsRead)await window.delaySettingsRead;return {settings:structuredClone(window.ui[user])};};
export const setUiSettings=async patch=>{const user=window.testAccount;window.uiWrites.push({user,patch});if(window.failSettingsSave){window.failSettingsSave=false;throw new Error('fixture failure');}window.ui[user]={...window.ui[user],...patch};return {settings:structuredClone(window.ui[user]),ok:true};};
export const setUserLanguage=async language=>{window.languageWrites.push({user:window.testAccount,language});return {ok:true,language};};
export const apiFetch=async()=>({});export const localMcpScope=()=>'';export const syncLocalMcp=async()=>{};
export const getModels=async()=>({models:[]});export const getModelSettings=async()=>({model_settings:{}});export const getSubagentModel=async()=>({subagent_model:null});export const getSubagentReasoningLevel=async()=>({reasoning_level:null});export const getLinkStatus=async()=>({});export const getContextTokenLimit=async()=>({});export const getAttachmentTokenLimit=async()=>({});export const getPrompts=async()=>({prompts:[]});
`;
const authSource = "import React from 'react';export const TestAuth=React.createContext(null);export const useAuth=()=>React.useContext(TestAuth);";
const source = `
import React,{useState,useRef,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {I18nextProvider,useTranslation} from 'react-i18next';
import {TestAuth} from 'fixture-auth';import * as api from 'fixture-api';
import i18n,{initializeI18n} from ${modulePath('i18n/index.ts')};
import {useThemeSettings} from ${modulePath('lib/use-theme-settings.ts')};
import {useSettingsRead} from ${modulePath('lib/useSettingsQueries.ts')};
import {saveAppUiSettings} from ${modulePath('lib/app-settings.ts')};
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
window.testAccount=1;window.ui={1:{show_tokens:true,dice_roll_enabled:false},2:{show_tokens:true,dice_roll_enabled:false}};window.uiWrites=[];window.languageWrites=[];
function Body({user,setUser}){
 const themeSettings=useThemeSettings('fixture-theme'),{t}=useTranslation();
 const [uiSettings,setUiSettingsState]=useState(user.ui_settings),[uiSettingsSaving,setUiSettingsSaving]=useState(false);
 const appScopeRef=useRef('');appScopeRef.current=String(user.id);
 const reads=useSettingsRead('ui',user.id,true);
 useEffect(()=>{if(reads.data)setUiSettingsState(reads.data.settings);},[reads.data]);
 const invalidateSettingsRead=()=>client.invalidateQueries({queryKey:['settings',api.API_BASE,user.id,'ui']});
 const toast={error(){}};
 ${nativeFlags}
 useEffect(()=>{window.settingsState=themeSettings.state;window.handleSettings=action=>themeSettings.handle(action);window.electronAPI.publishSettings(themeSettings.state);},[themeSettings.state]);
 return <><button id="native-tokens" onClick={handleToggleShowTokens} disabled={uiSettingsSaving}>{String(uiSettings.show_tokens!==false)}</button><output id="auth-tokens">{String(user.ui_settings.show_tokens!==false)}</output></>;
}
function App(){const [user,setUser]=useState({id:1,name:'fixture',role:'user',is_admin:0,language:'en',ui_settings:window.ui[1]});
 window.switchSettingsAccount=id=>{window.testAccount=id;setUser({id,name:'fixture',role:'user',is_admin:0,language:'en',ui_settings:window.ui[id]});};
 return <TestAuth.Provider value={{user,setUser}}><Body user={user} setUser={setUser}/></TestAuth.Provider>;
}
initializeI18n().then(()=>{createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={client}><I18nextProvider i18n={i18n}><App/></I18nextProvider></QueryClientProvider></React.StrictMode>);});
`;
const preload = "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{getSystemLanguages:async()=>['en'],getZoomLevel:()=>ipcRenderer.invoke('fixture:zoom'),setZoomLevel:value=>ipcRenderer.invoke('fixture:zoom',value),publishSettings:state=>ipcRenderer.send('fixture:settings',state)});";
const electron = String.raw`
const assert=require('node:assert/strict'),path=require('node:path');
const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const {InteractivePreviews}=require(process.env.CHATTER_DESKTOP+'/dist/main/interactive-preview.js');
const {INTERACTIVE_SCHEME}=require(process.env.CHATTER_DESKTOP+'/dist/main/interactive-document.js');
const {THEME_SETTINGS_EXAMPLES}=require(process.env.CHATTER_DESKTOP+'/dist/main/theme-documentation.js');
protocol.registerSchemesAsPrivileged([{scheme:INTERACTIVE_SCHEME,privileges:{standard:true,secure:true}}]);
app.setPath('userData',path.join(__dirname,'user-data'));let host,manager,id,theme,zoom=0,settings,mainError;
const deadline=setTimeout(()=>{console.error('settings fixture timeout',mainError);app.exit(1)},35000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let n=0;n<250;n++){if(mainError)throw mainError;if(await predicate())return;await sleep(15);}throw new Error('Settings UI condition timed out');};
const base={chats:[],folders:[],sections:[],activeChatId:1,view:'conversation',messages:[],labels:{save:'Save',cancel:'Discard',loading:'Loading'},canSend:true,sending:false};
const push=()=>{if(id&&settings)manager.updateAppearanceState(host.webContents,id,{...base,settings});};
ipcMain.handle('fixture:zoom',(_event,value)=>{if(value!==undefined)zoom=value;return zoom;});
ipcMain.on('fixture:settings',(event,state)=>{if(event.sender===host?.webContents){settings=state;push();}});
app.whenReady().then(async()=>{
 host=new BrowserWindow({show:false,width:1000,height:750,webPreferences:{sandbox:true,contextIsolation:true,preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
 host.webContents.on('console-message',(_event,level,message)=>{if(level===3)console.log('host:',message);});
 await host.loadFile(path.join(__dirname,'renderer/index.html'));
 await until(()=>settings?.sections.length>0);manager=new InteractivePreviews();
 const send=host.webContents.send.bind(host.webContents);
 host.webContents.send=(channel,payload)=>{
  if(channel==='interactive-preview:appearance-action'){
   if(payload.action.type==='settingsAction')void host.webContents.executeJavaScript('window.handleSettings('+JSON.stringify(payload.action)+')').catch(error=>{mainError=error});
  }
  return send(channel,payload);
 };
 id=manager.create(host.webContents,{language:'tsx',source:'',dark:false,errorLabel:'failed',bridge:'appearance-chat-list-v1',project:{entry:'App.tsx',files:{
  'App.tsx':"import React from 'react';import Section from './components/Section';import {useChatterState} from '@chatter/ui';export default function App(){const state=useChatterState();const [opened,setOpened]=React.useState(false);return <main><button id='open' onClick={()=>setOpened(true)}>App settings</button><input id='search' onChange={event=>window.chatter.searchSettings(event.target.value)}/><output id='search-result'>{state?.settings?.results[0]?.fieldId}</output>{opened&&<Section sectionId='app'/>}</main>}",
  'components/Field.tsx':THEME_SETTINGS_EXAMPLES['Field.tsx'],'components/Section.tsx':THEME_SETTINGS_EXAMPLES['Section.tsx'],
 }}});
 theme=host.contentView.children.at(-1).children[0].webContents;
 theme.on('console-message',(_event,level,message)=>{if(level===3)console.log('theme:',message);});push();
 const js=code=>theme.executeJavaScript(code);
 const element=id=>id.startsWith('setting-app-')?'document.querySelector('+JSON.stringify('[data-setting='+id.slice(12)+'] input,[data-setting='+id.slice(12)+'] select')+')':'document.getElementById('+JSON.stringify(id)+')';
 const click=id=>theme.executeJavaScript(element(id)+'.click()',true);
 const input=async(id,value)=>{await theme.executeJavaScript('(()=>{const el='+element(id)+';el.focus();Object.getOwnPropertyDescriptor(el.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event(el.tagName==="SELECT"?"change":"input",{bubbles:true}));})()',true);};
 const named=label=>theme.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button=>button.textContent==='+JSON.stringify(label)+').click()',true);
 await until(async()=>await js('!!document.getElementById("open")'));await click('open');await until(()=>settings?.editor?.fields.length===8);
 assert.equal(settings.editor.dirty,false);assert.equal(await host.webContents.executeJavaScript('window.uiWrites.length'),0);
 await input('search','scale');await until(()=>settings.results.some(result=>result.fieldId==='zoom'));assert.equal(settings.sections.some(section=>section.id==='admin'),false);
 await input('setting-app-zoom','120');await until(()=>settings.editor.fields.find(field=>field.id==='zoom').value==='120');assert.equal(zoom,0);
 await named('Discard');await until(()=>!settings.editor.dirty);assert.equal(zoom,0);
 await input('setting-app-zoom','125');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.ok(Math.abs(zoom-Math.log(1.25)/Math.log(1.2))<0.00001);
 await click('setting-app-showTokens');await until(()=>settings.editor.dirty);await named('Save');
 await until(async()=>!settings.editor.busy&&!settings.editor.dirty&&await host.webContents.executeJavaScript('window.ui[1].show_tokens===false'));
 await until(async()=>await host.webContents.executeJavaScript('document.getElementById("auth-tokens").textContent')==='false');
 await host.webContents.executeJavaScript('document.getElementById("native-tokens").click()',true);await until(async()=>await host.webContents.executeJavaScript('window.ui[1].show_tokens===true'));
 await until(()=>settings.editor.fields.find(field=>field.id==='showTokens').value===true);
 await host.webContents.executeJavaScript('window.failSettingsSave=true');await click('setting-app-diceRoll');await until(()=>settings.editor.dirty);await named('Save');
 await until(()=>!!settings.editor.error&&!settings.editor.busy);assert.equal(settings.editor.dirty,true);assert.equal(await host.webContents.executeJavaScript('window.ui[1].dice_roll_enabled'),false);
 await named('Discard');await until(()=>!settings.editor.dirty);
 await input('setting-app-language','ru');await until(()=>settings.editor.dirty);await named('Save');
 await until(async()=>!settings.editor.busy&&!settings.editor.dirty&&await host.webContents.executeJavaScript('window.languageWrites.length>0'));
 assert.equal(settings.sections.find(section=>section.id==='app').label,'Приложение');
 await input('setting-app-theme','schedule');await until(()=>settings.editor.fields.find(field=>field.id==='darkFrom').visible);assert.equal(await js('!!document.querySelector("[data-setting=darkFrom] input")'),true);
 await host.webContents.executeJavaScript('window.switchSettingsAccount(2)');await until(()=>settings.editor===null);assert.equal(await host.webContents.executeJavaScript('window.ui[2].dice_roll_enabled'),false);
 assert.equal(await js('[typeof electronAPI,typeof require].join(",")'),'undefined,undefined');
 console.log('PASS: isolated generated settings components, real host React draft lifecycle, Save/Discard, zoom IPC, native/API/Auth/cache synchronization, failures, live localization and account isolation');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(deadline);manager?.destroy();host?.destroy();app.exit(process.exitCode??0);});
`;
try {
  await build({ configFile: false, root: desktop, logLevel: 'error', plugins: [{ name: 'theme-settings-fixture', enforce: 'pre',
    resolveId(id: string) {
      if (id === 'fixture-auth' || id.endsWith('/lib/auth') || id === './auth') return '\0fixture-auth';
      if (id === 'fixture-api' || id.endsWith('/lib/api') || id === './api') return '\0fixture-api';
      if (id === 'settings-fixture.tsx') return '\0settings-fixture.tsx';
    },
    async load(id: string) {
      if (id === '\0fixture-auth') return transformWithEsbuild(authSource, 'fixture-auth.tsx', { loader: 'tsx', jsx: 'automatic' });
      if (id === '\0fixture-api') return apiSource;
      if (id === '\0settings-fixture.tsx') return transformWithEsbuild(source, 'settings-fixture.tsx', { loader: 'tsx', jsx: 'automatic' });
    },
  }], build: { outDir: path.join(directory, 'renderer'), rollupOptions: { input: 'settings-fixture.tsx', output: { entryFileNames: 'entry.js' },
    onwarn(warning: { code?: string }, warn: (warning: unknown) => void) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } } } });
  fs.writeFileSync(path.join(directory, 'renderer/index.html'), '<meta charset="UTF-8"><div id="root"></div><script type="module" src="./entry.js"></script>');
  fs.writeFileSync(path.join(directory, 'preload.cjs'), preload); fs.writeFileSync(path.join(directory, 'main.cjs'), electron);
  const env = { ...process.env, CHATTER_DESKTOP: desktop }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Settings Electron timeout: ' + output)); }, 45000);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); }); child.once('error', reject);
  });
  process.stdout.write(output); assert.equal(code, 0);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('chatter-theme-settings-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
