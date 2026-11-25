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
const apiFile = fs.readFileSync(path.join(desktop, 'src/renderer/lib/api.ts'), 'utf8');
const credentialWriters = apiFile.slice(apiFile.indexOf('export function changeAccountPassword'), apiFile.indexOf('export async function setUserTimezone'));
const promptWriters = apiFile.slice(apiFile.indexOf('export async function selectPrompt'), apiFile.indexOf('// ---------- Notes ----------'));
const characterChatWriter = apiFile.slice(apiFile.indexOf('export async function startCharacterCardChat'),apiFile.indexOf('export type PromptsResponse'));
const apiSource = `
export const API_BASE='fixture';
export const getUiSettings=async()=>{const user=window.testAccount;if(window.delaySettingsRead)await window.delaySettingsRead;return {settings:structuredClone(window.ui[user])};};
export const setUiSettings=async patch=>{const user=window.testAccount;window.uiWrites.push({user,patch});if(window.failSettingsSave){window.failSettingsSave=false;throw new Error('fixture failure');}window.ui[user]={...window.ui[user],...patch};return {settings:structuredClone(window.ui[user]),ok:true};};
export const setUserLanguage=async language=>{window.languageWrites.push({user:window.testAccount,language});return {ok:true,language};};
export const apiFetch=async(url,options={})=>{
 const payload=options.body?JSON.parse(options.body):{};
 if(url==='/api/v1/user/password'||url==='/api/v1/user/login'){
  window.credentialRequests=(window.credentialRequests||0)+1;
  if(window.failCredentials){window.failCredentials=false;throw new Error('wrong_current_password');}
  if(window.delayCredentials)await window.delayCredentials;
  if((payload.current_password||payload.password)!=='correct-fixture-password')throw new Error('wrong_current_password');
  if(url.endsWith('/password')&&payload.new_password!=='new-fixture-password')throw new Error('bad_password_length');
  return {ok:true,...(url.endsWith('/login')?{login:payload.new_login.toLowerCase()}: {})};
 }
 if(url==='/api/v1/memory/status')return {configured:true};
 if(url.startsWith('/api/v1/player-instructions?'))return structuredClone(window.instructions);
 if(url==='/api/v1/player-instructions'&&options.method==='PATCH'){
  if(payload.expected!==window.instructions.text)throw new Error('instructions_changed');
  window.instructions.text=payload.text.trim();return structuredClone(window.instructions);
 }
 if(url==='/api/v1/player-instructions/surveys'){
  const survey={id:'survey-fixture',scope:'persona',target_id:payload.target_id,questionnaire:{id:'prefs',title:'Preferences',questions:[{id:'style',label:'Preferred style',type:'text',required:true}]},answers:null,draft:null,applied_text:null,created_at:123,include_history:false,personalize:payload.personalize,model_id:payload.model_id??null};
  window.instructions.surveys.push(survey);window.surveyInputs=payload;return {survey:structuredClone(survey)};
 }
 if(url.endsWith('/survey-fixture/answers')){const survey=window.instructions.surveys[0];survey.answers=payload.answers;survey.draft='Generated instruction proposal';return {survey:structuredClone(survey)};}
 if(url.endsWith('/survey-fixture/apply')){window.instructions.text=payload.text;window.instructions.surveys[0].applied_text=payload.text;return structuredClone(window.instructions);}
 if(url.endsWith('/survey-fixture')&&options.method==='DELETE'){window.instructions.surveys=[];return structuredClone(window.instructions);}
 if(url.endsWith('/start-chat'))return {chat_id:77,message_id:88};
 if(url==='/api/v1/intuition'){
  if(options.method==='PUT'){if(payload.revision!==window.intuition.revision)throw new Error('intuition_settings_changed');window.intuition={...window.intuition,revision:window.intuition.revision+1,settings:payload.settings};}
  return structuredClone(window.intuition);
 }
 if(url==='/api/v1/intuition/suggest')return {questions:[{id:'suggested',name:'Suggestion',question:'Notice humor?',enabled:true}]};
 if(url==='/api/v1/prompts')return structuredClone(window.prompts);
 if(url==='/api/v1/prompts/select'){window.prompts.selected_prompt_id=payload.prompt_id;return {ok:true};}
 if(url==='/api/v1/prompts/generate')return {generated_prompt:'Generated proposal'};
 if(url==='/api/v1/prompts/custom'&&options.method==='POST'){const id=-1001;window.prompts.custom_prompts.push({...payload,id,image_url:null});window.prompts.selected_prompt_id=id;return {ok:true,prompt_id:id};}
 if(url==='/api/v1/memory/personas'&&options.method==='POST'){const persona={...payload,id:2,image_url:null,is_primary:0,is_default:0,allow_core_memory_update:payload.allow_core_memory_update?1:0};window.personas.push(persona);return {persona};}
 if(url==='/api/v1/memory/personas'){window.personaReads=(window.personaReads||0)+1;return {personas:structuredClone(window.personas)};}
 if(url.startsWith('/api/v1/memory/personas/')&&options.method==='PATCH'){const persona=window.personas.find(p=>p.id===Number(url.split('/').at(-1)));Object.assign(persona,payload,{allow_core_memory_update:payload.allow_core_memory_update?1:0});return {persona:structuredClone(persona)};}
 if(url.includes('/memory/personas/')&&url.endsWith('/activate')){const id=Number(url.split('/').at(-2));window.personas=window.personas.map(p=>({...p,is_default:p.id===id?1:0}));return {};}
 if(url==='/api/v1/memory/spaces'&&options.method==='POST'){const space={id:3,name:payload.name,kind:'general',is_default:0,is_primary:0};window.memorySpaces.push(space);return {space};}
 if(url==='/api/v1/memory/spaces')return {spaces:structuredClone(window.memorySpaces)};
 if(url.includes('/memory/spaces/')&&url.endsWith('/activate')){const id=Number(url.split('/')[5]);window.memorySpaces=window.memorySpaces.map(space=>({...space,is_default:space.id===id?1:0}));return {space:window.memorySpaces.find(space=>space.id===id)};}
 if(url.startsWith('/api/v1/memory/records?')){return {records:structuredClone(window.memoryRecords),total:window.memoryRecords.length,nextOffset:null};}
 if(url.includes('/memory/records/')&&options.method==='PATCH'){const record=window.memoryRecords.find(record=>record.id===url.split('/').at(-1));Object.assign(record,payload);return {record:structuredClone(record)};}
 if(url.includes('/memory/records/')&&options.method==='DELETE'){window.memoryRecords=window.memoryRecords.filter(record=>record.id!==url.split('/').at(-1));return {deleted:true};}
 return {};
};export const localMcpScope=()=>'';export const syncLocalMcp=async()=>{};
${credentialWriters}
${promptWriters}
${characterChatWriter}
export const setPersonaImage=async()=>{window.avatarUploads=(window.avatarUploads||0)+1;return {ok:true};};export const deletePersonaImage=async()=>({ok:true});export const resolveImageUrl=value=>value;
export const getModels=async()=>({models:[{id:'smart',name:'Smart',reasoning_levels:['high']},{id:'simple',name:'Simple',reasoning_levels:[]}],preferred_model:'smart',auto_reasoning_levels:['high']});export const getModelSettings=async()=>({model_settings:{}});export const getSubagentModel=async()=>({subagent_model:window.agentModel});export const getSubagentReasoningLevel=async()=>({reasoning_level:window.agentReasoning});export const getLinkStatus=async()=>({});export const getPrompts=async()=>({prompts:[]});
export const getContextTokenLimit=async()=>({max_context_tokens:window.contextTokens,max_context_tokens_limit:30000});
export const getAttachmentTokenLimit=async()=>({attachment_max_tokens:Math.min(window.attachmentTokens,Math.floor(window.contextTokens*.9)),attachment_max_tokens_limit:Math.floor(window.contextTokens*.9),max_context_tokens:window.contextTokens});
export const setContextTokenLimit=async value=>{window.contextTokens=value;return getContextTokenLimit();};export const setAttachmentTokenLimit=async value=>{window.attachmentTokens=Math.min(value,Math.floor(window.contextTokens*.9));return getAttachmentTokenLimit();};
export const fetchMe=async()=>{const result={id:window.testAccount,...window.account};if(window.delayAccountRead)await window.delayAccountRead;window.accountReadsReturned=(window.accountReadsReturned||0)+1;return result;};export const setUserName=async name=>{window.account.name=name;return {name};};export const setUserTimezone=async offset=>{window.account.timezone_offset=offset;window.account.timezone_confirmed=true;return {timezone_offset:offset,timezone_confirmed:true};};
export const setSubagentModel=async value=>{window.agentModel=value;return {subagent_model:value};};export const setSubagentReasoningLevel=async value=>{window.agentReasoning=value;return {reasoning_level:value};};
export const fetchTranscriptionStatus=async()=>({available:true});export const fetchTtsProviders=async()=>({providers:[{id:'remote-fixture',name:'Remote fixture',voices:[{id:'remote-voice',name:'Fixture voice',language:'en'}]}]});
export const getMemoryPreferences=async()=>({preferences:window.memoryPreferences});export const patchMemoryPreferences=async patch=>{window.memoryPreferences={...window.memoryPreferences,...patch};return getMemoryPreferences();};
export const getSubagentCatalog=async()=>({agents:[{id:'search',name:'Fixture search',description:'Fixture description',icon:'globe'}]});
export const fetchQuota=async()=>{if(window.delayQuota)await window.delayQuota;return {billing_mode:'tokens',percent:25,tokens:{used:25,quota:100},cost:{used:0,quota:0},resets_at:123456,quota:null};};
export const generateTts=async()=>{throw new Error('No audio generation in settings tests');};export const fetchAudioBuffer=generateTts;export const fetchTtsVoicePreview=generateTts;
export const resolveAuthenticatedAssetUrl=value=>value;
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
window.contextTokens=20000;window.attachmentTokens=15000;window.agentModel='smart';window.agentReasoning='high';window.account={name:'Fixture',plan:'pro',role:'user',timezone_offset:null,timezone_confirmed:false};
window.memoryPreferences={automatic_memory:false,result_limit:null,admin_result_limit:7,effective_result_limit:7};
window.memorySpaces=[{id:1,name:'General',kind:'general',is_default:1,is_primary:1},{id:2,name:'Chat only',kind:'chat',is_default:0,is_primary:0}];window.memoryRecords=[{id:'record-fixture',memory_space_id:1,text:'Before',source:'Fixture',updated_at:1}];window.authInvalidations=0;
window.intuition={revision:0,settings:{mode:'disabled',historyMessages:null,questions:null},available:true,defaults:[],effective:{enabled:false,historyMessages:2,questions:[]}};
window.prompts={prompts:[{id:1,name:'Builtin',description:'Default',is_default:1}],custom_prompts:[],selected_prompt_id:1,custom_prompt_content:null,max_custom_prompt_length:1000};
window.personas=[{id:1,name:'Main',description:'Main',core_memory:'Memory',user_instructions:'',image_url:null,allow_core_memory_update:1,is_primary:1,is_default:1}];
window.instructions={text:'Original instructions',enabled:true,mode:'both',surveys:[]};window.createdChats=[];
localStorage.setItem('chatter_tts_settings',JSON.stringify({modelId:'piper',voiceId:'ruslan',volume:.3,sfxVolume:.3}));
function Body({user,setUser}){
 const themeSettings=useThemeSettings('fixture-theme',()=>{window.authInvalidations++;},id=>window.createdChats.push(id)),{t}=useTranslation();
 const [uiSettings,setUiSettingsState]=useState(user.ui_settings),[uiSettingsSaving,setUiSettingsSaving]=useState(false);
 const appScopeRef=useRef('');appScopeRef.current=String(user.id);
 const reads=useSettingsRead('ui',user.id,true);
 useEffect(()=>{if(reads.data)setUiSettingsState(reads.data.settings);},[reads.data]);
 const invalidateSettingsRead=()=>client.invalidateQueries({queryKey:['settings',api.API_BASE,user.id,'ui']});
 const toast={error(){}};
 ${nativeFlags}
 useEffect(()=>{window.settingsState=themeSettings.state;window.handleSettings=action=>themeSettings.handle(action);window.electronAPI.publishSettings(themeSettings.state);},[themeSettings.state]);
 useEffect(()=>{window.handleSettingsRequest=async({id,request})=>{let result,error;try{result=await themeSettings.request(request);}catch(reason){error=reason.message;}finally{request.params={};}await window.electronAPI.replySettings(id,request.requestId,result,error);themeSettings.completeRequest(request.requestId);};},[themeSettings.state]);
 return <><button id="native-tokens" onClick={handleToggleShowTokens} disabled={uiSettingsSaving}>{String(uiSettings.show_tokens!==false)}</button><output id="auth-tokens">{String(user.ui_settings.show_tokens!==false)}</output></>;
}
function App(){const [user,setUser]=useState({id:1,name:'fixture',role:'user',is_admin:0,language:'en',ui_settings:window.ui[1]});const [mounted,setMounted]=useState(true);window.setSettingsMounted=setMounted;
 window.switchSettingsAccount=id=>{window.testAccount=id;setUser({id,name:'fixture',role:'user',is_admin:0,language:'en',ui_settings:window.ui[id]});};
 return <TestAuth.Provider value={{user,setUser}}><output id="account-name">{user.name}</output>{mounted&&<Body user={user} setUser={setUser}/>}</TestAuth.Provider>;
}
initializeI18n().then(()=>{createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={client}><I18nextProvider i18n={i18n}><App/></I18nextProvider></QueryClientProvider></React.StrictMode>);});
`;
const preload = "const {contextBridge,ipcRenderer}=require('electron');let browser={concurrency:2,searchEnabled:true,readerEnabled:true};contextBridge.exposeInMainWorld('electronAPI',{pickAttachmentFiles:kind=>ipcRenderer.invoke('composer:pick-files',kind),readPickedAttachment:(id,index)=>ipcRenderer.invoke('composer:read-picked-file',id,index),releasePickedAttachments:id=>ipcRenderer.invoke('composer:release-picked-files',id),getSystemLanguages:async()=>['en'],listPiperVoices:async()=>[{id:'ruslan',name:'Ruslan',lang:'ru'}],ttsGenerate:()=>ipcRenderer.invoke('fixture:tts'),localAppearance:payload=>ipcRenderer.invoke('fixture:appearance',payload),saveFile:async()=>({canceled:true}),replySettings:(id,requestId,result,error)=>ipcRenderer.invoke('fixture:settings-reply',id,requestId,result,error),getDesktopBrowserSettings:async()=>browser,setDesktopBrowserSettings:async value=>{browser=value;return browser;},getZoomLevel:()=>ipcRenderer.invoke('fixture:zoom'),setZoomLevel:value=>ipcRenderer.invoke('fixture:zoom',value),publishSettings:state=>ipcRenderer.send('fixture:settings',state)});";
const electron = String.raw`
const assert=require('node:assert/strict'),path=require('node:path');
const {app,BrowserWindow,protocol,ipcMain}=require('electron');
const {AttachmentPicker}=require(process.env.CHATTER_DESKTOP+'/dist/main/attachment-picker.js');
const {InteractivePreviews}=require(process.env.CHATTER_DESKTOP+'/dist/main/interactive-preview.js');
const {INTERACTIVE_SCHEME}=require(process.env.CHATTER_DESKTOP+'/dist/main/interactive-document.js');
const {THEME_SETTINGS_EXAMPLES}=require(process.env.CHATTER_DESKTOP+'/dist/main/theme-documentation.js');
const {newAppearance}=require(process.env.CHATTER_DESKTOP+'/dist/main/appearance-schema.js');
protocol.registerSchemesAsPrivileged([{scheme:INTERACTIVE_SCHEME,privileges:{standard:true,secure:true}}]);
app.setPath('userData',path.join(__dirname,'user-data'));let host,manager,id,theme,zoom=0,settings,mainError;
let previewRequests=0,finishPreview;
const fixtureProfile=newAppearance('fixture-saved'),drafts={};
const themeSnapshot={appearance:{version:1,revision:1,activeId:null,profiles:[fixtureProfile]},workspace:{directory:__dirname,draftsDirectory:__dirname+'/.drafts',documentation:__dirname+'/THEMES.md',activeId:null,profiles:[],drafts:[],migrationComplete:true,migrationErrors:[],issues:[]}};
const avatarPicker=new AttachmentPicker();let avatarPickerMode='ok',avatarPickerCalls=0;
const avatarPath=path.join(__dirname,'picked-avatar.png');require('node:fs').writeFileSync(avatarPath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=','base64'));
ipcMain.handle('composer:pick-files',(event,kind)=>{assert.equal(kind,'profile-image');avatarPickerCalls++;return avatarPicker.choose(event.sender.id,async()=>avatarPickerMode==='cancel'?[]:[avatarPath]);});
ipcMain.handle('composer:read-picked-file',(event,id,index)=>avatarPicker.read(event.sender.id,id,index));
ipcMain.handle('composer:release-picked-files',(event,id)=>avatarPicker.release(event.sender.id,id));
const deadline=setTimeout(()=>{console.error('settings fixture timeout',mainError);app.exit(1)},35000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let n=0;n<250;n++){if(mainError)throw mainError;if(await predicate())return;await sleep(15);}throw new Error('Settings UI condition timed out');};
const base={chats:[],folders:[],sections:[],activeChatId:1,view:'conversation',messages:[],labels:{save:'Save',cancel:'Discard',loading:'Loading'},canSend:true,sending:false};
const push=()=>{if(id&&settings)manager.updateAppearanceState(host.webContents,id,{...base,settings});};
ipcMain.handle('fixture:zoom',(_event,value)=>{if(value!==undefined)zoom=value;return zoom;});
ipcMain.handle('fixture:tts',()=>{previewRequests++;return new Promise(resolve=>{finishPreview=resolve;});});
ipcMain.handle('fixture:settings-reply',(_event,previewId,requestId,result,error)=>manager.resolveAppearanceDocument(host.webContents,previewId,requestId,result,error));
ipcMain.handle('fixture:appearance',(_event,payload)=>{if(payload.action==='load')return structuredClone(themeSnapshot);if(payload.action==='write-draft'){drafts[payload.profile.id]=payload.profile;if(!themeSnapshot.workspace.drafts.some(item=>item.id===payload.profile.id))themeSnapshot.workspace.drafts.push({id:payload.profile.id,directory:__dirname+'/.drafts/'+payload.profile.id});return {written:true};}if(payload.action==='read-draft')return drafts[payload.id];throw new Error('Unexpected fixture appearance operation');});
ipcMain.on('fixture:settings',(event,state)=>{if(event.sender===host?.webContents){settings=state;push();}});
app.whenReady().then(async()=>{
 host=new BrowserWindow({show:false,width:1000,height:750,webPreferences:{sandbox:true,contextIsolation:true,preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}});
 host.webContents.on('console-message',(_event,level,message)=>{if(level===3)console.log('host:',message);});
 await host.loadFile(path.join(__dirname,'renderer/index.html'));
 await until(()=>settings?.sections.length>0);manager=new InteractivePreviews();
 const send=host.webContents.send.bind(host.webContents);
 host.webContents.send=(channel,payload)=>{
  if(channel==='interactive-preview:appearance-action'){
   if(payload.action.type==='settingsAction')void host.webContents.executeJavaScript('void window.handleSettings('+JSON.stringify(payload.action)+')').catch(error=>{mainError=error});
  }
  if(channel==='interactive-preview:appearance-document')void host.webContents.executeJavaScript('void window.handleSettingsRequest('+JSON.stringify(payload)+')').catch(error=>{mainError=error});
  return send(channel,payload);
 };
 id=manager.create(host.webContents,{language:'tsx',source:'',dark:false,errorLabel:'failed',bridge:'appearance-chat-list-v1',project:{entry:'App.tsx',files:{
  'App.tsx':"import React from 'react';import Section from './components/Section';import AccountSecurity from './components/AccountSecurity';import SdkProbe from './components/SdkProbe';import {useChatterState} from '@chatter/ui';export default function App(){const state=useChatterState();const [section,setSection]=React.useState('');const [sdk,setSdk]=React.useState(false);window.sdkToggle=setSdk;return <main>{['app','voice','account','limits','agents','memory','browser','intuition','prompt','personas'].map(id=><button key={id} id={id==='app'?'open':'open-'+id} onClick={()=>{window.chatter.openSettingsSection(id);setSection(id);}}>{id}</button>)}<input id='search' onChange={event=>window.chatter.searchSettings(event.target.value)}/><output id='search-result'>{state?.settings?.results[0]?.fieldId}</output>{section&&<Section key={section} sectionId={section}/>}{section==='account'&&<AccountSecurity/>}{sdk&&<SdkProbe/>}</main>}",
  'components/Field.tsx':THEME_SETTINGS_EXAMPLES['Field.tsx'],'components/Section.tsx':THEME_SETTINGS_EXAMPLES['Section.tsx'],
  'components/AccountSecurity.tsx':THEME_SETTINGS_EXAMPLES['AccountSecurity.tsx'],
  'components/SdkProbe.tsx':"import React from 'react';import {usePersonaEditor,useIntuitionEditor,useSettingsSection,useProfileAvatar} from '@chatter/ui';export default function SdkProbe(){const avatar=useProfileAvatar('personas',1);const a=usePersonaEditor(1),b=usePersonaEditor(1),i=useIntuitionEditor(),voice=useSettingsSection('voice'),section=useSettingsSection('personas');window.sdkReload=section.reload;return <section id='sdk-probe'><button id='sdk-choose-avatar' disabled={avatar.loading||avatar.busy} onClick={()=>void avatar.choose()}>Choose avatar</button><button id='sdk-save-avatar' disabled={!avatar.canSave||avatar.busy} onClick={()=>void avatar.save()}>Save avatar</button><button id='sdk-discard-avatar' onClick={avatar.discard}>Discard avatar</button><output id='sdk-avatar-source'>{avatar.source}</output><output id='sdk-avatar-error'>{avatar.error}</output><input id='sdk-name-a' {...a.bind('name')}/><input id='sdk-name-b' {...b.bind('name')}/><button id='sdk-save-persona' disabled={!a.canSave} onClick={()=>void a.save()}>Save persona</button><input id='sdk-history' type='number' {...i.bind('historyMessages')}/><button id='sdk-save-intuition' disabled={!i.canSave} onClick={()=>void i.save()}>Save intuition</button><output id='sdk-error'>{a.error||i.error}</output><output id='sdk-can-reload'>{String(section.canReload)}</output><output id='sdk-voice'>{voice.ready?'ready':'loading'}</output></section>}",
 }}});
 theme=host.contentView.children.at(-1).children[0].webContents;
 theme.on('console-message',(_event,level,message)=>{if(level===3)console.log('theme:',message);});push();
 const js=code=>theme.executeJavaScript(code);
 const element=id=>id.startsWith('setting-app-')?'document.querySelector('+JSON.stringify('[data-setting='+id.slice(12)+'] input,[data-setting='+id.slice(12)+'] select')+')':'document.getElementById('+JSON.stringify(id)+')';
 const click=id=>theme.executeJavaScript(element(id)+'.click()',true);
 const input=async(id,value)=>{await theme.executeJavaScript('(()=>{const el='+element(id)+';el.focus();Object.getOwnPropertyDescriptor(el.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event(el.tagName==="SELECT"?"change":"input",{bubbles:true}));})()',true);};
 const named=label=>theme.executeJavaScript('Array.from(document.querySelectorAll("button")).find(button=>button.textContent==='+JSON.stringify(label)+').click()',true);
 const resource=async(section,operation,params={},gesture=false)=>{await theme.executeJavaScript('window.resourceValue=undefined;window.resourceError=undefined;void window.chatter.requestSettings('+JSON.stringify(section)+','+JSON.stringify(operation)+','+JSON.stringify(params)+').then(value=>{window.resourceValue=value},error=>{window.resourceError=error.message});void 0',gesture);
  await until(async()=>await js('window.resourceValue!==undefined||window.resourceError!==undefined'));const error=await js('window.resourceError');if(error)throw new Error(error);return js('window.resourceValue');};
 await until(async()=>await js('!!document.getElementById("open")'));await click('open');await until(()=>settings?.editor?.fields.length===14);
 assert.equal(settings.editor.dirty,false);assert.equal(await host.webContents.executeJavaScript('window.uiWrites.length'),0);
 await click('setting-app-themeSoundEnabled');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_theme_effects")).soundEnabled'),true);
 await click('setting-app-themeSoundEnabled');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal((await resource('app','listThemes')).profiles[0].id,'fixture-saved');
 const appearanceSchema=await resource('app','getAppearanceSchema');appearanceSchema.template.id='fixture-draft';
 await resource('app','writeDraft',{profile:appearanceSchema.template},true);assert.equal((await resource('app','readDraft',{id:'fixture-draft'})).profile.id,'fixture-draft');
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
 await named('Discard');await until(()=>!settings.editor.dirty);
 await click('open-voice');await until(()=>settings.editor?.sectionId==='voice'&&settings.editor.fields.length===14);
 assert.equal(settings.editor.fields.find(field=>field.id==='voiceId').value,'ruslan');
 await theme.executeJavaScript('document.querySelector("[data-settings-action=previewVoice]").click()',true);
 await until(()=>previewRequests===1&&settings.editor.actions.some(action=>action.id==='previewVoice'&&action.active));
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_tts_settings")).modelId'),'piper');
 await theme.executeJavaScript('document.querySelector("[data-settings-action=stopPreview]").click()',true);
 await until(()=>!settings.editor.actions.some(action=>action.active));finishPreview(null);
 assert.equal(settings.editor.error,null);assert.equal(settings.editor.dirty,false,'preview and stop never save or dirty settings');
 await input('setting-app-modelId','remote-fixture');await until(()=>settings.editor.fields.find(field=>field.id==='voiceId').value==='remote-voice');
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_tts_settings")).modelId'),'piper');
 await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_tts_settings")).voiceId'),'remote-voice');
 await input('setting-app-volume','0.55');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_tts_settings")).volume'),0.55);
 await input('setting-app-recognitionSource','server');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('localStorage.getItem("chatter_speech_recognition_source")'),'server');
 await input('setting-app-wakeSensitivity','65');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_wake_word_config")).sensitivity'),65);
 await click('open-account');await until(()=>settings.editor?.sectionId==='account'&&settings.editor.fields.length===2);
 await input('setting-app-name','  Updated fixture  ');await input('setting-app-timezone','5.75');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('window.account.name'),'Updated fixture');assert.equal(await host.webContents.executeJavaScript('window.account.timezone_offset'),5.75);
 assert.equal(await host.webContents.executeJavaScript('JSON.parse(localStorage.getItem("chatter_user")).name'),'Updated fixture');
 assert.equal((await resource('account','getAccount')).passwordRules.minLength,8);
 await assert.rejects(resource('account','changePassword',{currentPassword:'correct-fixture-password',newPassword:'tiny'},true),/settings_bad_request/);
 const fillSecurity=async(index,name,value)=>theme.executeJavaScript('document.querySelectorAll("form")['+index+'].elements.namedItem('+JSON.stringify(name)+').value='+JSON.stringify(value));
 await host.webContents.executeJavaScript('window.failCredentials=true');await fillSecurity(0,'currentPassword','correct-fixture-password');await fillSecurity(0,'value','new-fixture-password');
 await theme.executeJavaScript('document.querySelectorAll("form")[0].requestSubmit()',true);
 await until(async()=>await js('document.body.textContent.includes("wrong_current_password")'));assert.equal(await host.webContents.executeJavaScript('window.authInvalidations'),0);
 await host.webContents.executeJavaScript('window.delayCredentials=new Promise(resolve=>{window.finishCredentials=resolve});void 0');
 await fillSecurity(0,'currentPassword','correct-fixture-password');await fillSecurity(0,'value','new-fixture-password');await theme.executeJavaScript('document.querySelectorAll("form")[0].requestSubmit()',true);
 await until(()=>settings.editor.busy&&manager.entries.get(id).documentRequests.size===1);
 assert.equal(JSON.stringify(settings).includes('fixture-password'),false);
 assert.equal(JSON.stringify([...manager.entries.get(id).documentRequests.values()].map(item=>item.request)).includes('fixture-password'),false,'the main process retains only scope metadata');
 assert.equal(await js('document.querySelectorAll("form")[0].elements.namedItem("currentPassword").value'),'');
 await host.webContents.executeJavaScript('window.finishCredentials();window.delayCredentials=null;void 0');await until(async()=>await host.webContents.executeJavaScript('window.authInvalidations')===1);
 await fillSecurity(1,'currentPassword','correct-fixture-password');await fillSecurity(1,'value','new.fixture');await theme.executeJavaScript('document.querySelectorAll("form")[1].requestSubmit()',true);
 await until(async()=>await host.webContents.executeJavaScript('window.authInvalidations')===2);
 await click('open-limits');await until(()=>settings.editor?.sectionId==='limits'&&settings.editor.fields.length===5);
 assert.equal((await resource('limits','getQuota')).percent,25);
 await host.webContents.executeJavaScript('window.delayQuota=new Promise(resolve=>{window.finishQuota=resolve});void 0');
 await theme.executeJavaScript('window.cancelError=undefined;void window.chatter.requestSettings("limits","getQuota").catch(error=>{window.cancelError=error.message});void 0');
 await until(()=>manager.entries.get(id).documentRequests.size===1);
 assert.equal(await js('window.chatter.cancelSettingsRequests("limits")'),true);
 await until(async()=>await js('window.cancelError')==='settings_request_canceled');await until(()=>manager.entries.get(id).documentRequests.size===0);
 await host.webContents.executeJavaScript('window.finishQuota();window.delayQuota=null;void 0');
 await input('setting-app-contextTokens','10000');await until(()=>settings.editor.fields.find(field=>field.id==='attachmentTokens').max===9000);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(settings.editor.fields.find(field=>field.id==='attachmentTokens').value,9000);
 await click('setting-app-desktopSearch');await input('setting-app-browserConcurrency','4');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('window.electronAPI.getDesktopBrowserSettings().then(value=>value.searchEnabled)'),false);
 assert.equal(await host.webContents.executeJavaScript('window.electronAPI.getDesktopBrowserSettings().then(value=>value.concurrency)'),4);
 await click('open-agents');await until(()=>settings.editor?.sectionId==='agents'&&settings.editor.fields.length===2);
 assert.equal((await resource('agents','listAgents')).agents[0].id,'search');
 await input('setting-app-model','simple');await until(()=>settings.editor.fields.find(field=>field.id==='reasoning').value==='');await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('window.agentModel'),'simple');assert.equal(await host.webContents.executeJavaScript('window.agentReasoning'),null);
 await click('open-memory');await until(()=>settings.editor?.sectionId==='memory'&&settings.editor.fields.length===2);
 assert.equal((await resource('memory','listSpaces')).spaces.length,1);
 assert.equal((await resource('memory','listRecords',{spaceId:1})).records[0].text,'Before');
 await resource('memory','updateRecord',{recordId:'record-fixture',text:'After'},true);
 assert.equal(await host.webContents.executeJavaScript('window.memoryRecords[0].text'),'After');
 await resource('memory','deleteRecord',{recordId:'record-fixture',confirmed:true},true);assert.equal(await host.webContents.executeJavaScript('window.memoryRecords.length'),0);
 await input('setting-app-resultLimit','12');await click('setting-app-automaticMemory');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('window.memoryPreferences.result_limit'),12);assert.equal(await host.webContents.executeJavaScript('window.memoryPreferences.automatic_memory'),true);
 await click('open-browser');await until(()=>settings.editor?.sectionId==='browser'&&settings.editor.fields.length===4);
 assert.equal(settings.editor.fields.find(field=>field.id==='autoOpen').value,false);
 await click('setting-app-autoOpen');await click('setting-app-humanTyping');await until(()=>settings.editor.dirty);await named('Save');await until(()=>!settings.editor.busy&&!settings.editor.dirty);
 assert.equal(await host.webContents.executeJavaScript('window.ui[1].browser_confirm_open'),false);assert.equal(await host.webContents.executeJavaScript('window.ui[1].browser_human_typing'),false);
 assert.equal(await host.webContents.executeJavaScript('window.ui[1].show_tokens'),true);
 await click('open-intuition');await until(()=>settings.editor?.sectionId==='intuition'&&!settings.editor.loading);
 assert.equal(settings.editor.fields.length,0);assert.ok(settings.editor.requests.some(item=>item.id==='saveIntuitionConfig'));
 assert.equal((await resource('intuition','getIntuitionConfig')).settings.mode,'disabled');
 const intuitionSettings={mode:'enabled',historyMessages:3,questions:[]};await resource('intuition','saveIntuitionConfig',{settings:intuitionSettings},true);
 assert.equal(await host.webContents.executeJavaScript('window.intuition.settings.mode'),'enabled');
 assert.equal((await resource('intuition','suggestIntuitionQuestions',{brief:'Humor'},true)).questions[0].id,'suggested');
 assert.deepEqual(await host.webContents.executeJavaScript('window.intuition.settings.questions'),[],'generated questions remain unsaved');
 const resourceEditor=settings.editor.id;await host.webContents.executeJavaScript('window.dispatchEvent(new Event("focus"))');await sleep(60);
 assert.equal(settings.editor.id,resourceEditor,'focus must preserve operation-only form drafts');
 await click('open-prompt');await until(()=>settings.editor?.sectionId==='prompt'&&!settings.editor.loading);
 assert.equal(settings.sections.find(item=>item.id==='prompt').mode,'hybrid');assert.equal((await resource('prompt','listPrompts')).selected_prompt_id,1);
 assert.equal((await resource('prompt','generatePrompt',{instruction:'Proposal'},true)).generated_prompt,'Generated proposal');
 assert.equal(await host.webContents.executeJavaScript('window.prompts.custom_prompts.length'),0);
 const createdPrompt=await resource('prompt','createPrompt',{name:'Fixture prompt',description:'Description',content:'Content'},true);
 assert.equal(createdPrompt.createdId,-1001);assert.equal(createdPrompt.selected_prompt_id,-1001);
 assert.equal((await resource('prompt','listGenerationModels')).selectedId,'smart');
 const sections=(await resource('prompt','parsePromptSections',{content:'Free form'})).sections;assert.equal(sections.description,'Free form');
 assert.ok((await resource('prompt','serializePromptSections',{sections})).content.includes('# DESCRIPTION'));
 const cropSource=await host.webContents.executeJavaScript('(()=>{const c=document.createElement("canvas");c.width=4;c.height=2;const ctx=c.getContext("2d");ctx.fillStyle="#ff0000";ctx.fillRect(0,0,2,2);ctx.fillStyle="#0000ff";ctx.fillRect(2,0,2,2);return c.toDataURL("image/png").split(",")[1];})()');
 const cropped=await resource('prompt','cropProfileImage',{base64:cropSource,mimeType:'image/png',crop:{x:0,y:0,size:2},outputSize:2},true);assert.equal(cropped.width,2);
 const pixel=await js('new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const c=document.createElement("canvas");c.width=2;c.height=2;const ctx=c.getContext("2d");ctx.drawImage(image,0,0);resolve(Array.from(ctx.getImageData(0,0,1,1).data));};image.onerror=reject;image.src='+JSON.stringify(cropped.previewUrl)+';})');assert.deepEqual(pixel,[255,0,0,255]);
 await host.webContents.executeJavaScript('window.prompts.custom_prompts[0].character_card={first_message_present:true}');await resource('prompt','listPrompts');
 assert.equal((await resource('prompt','startPromptChat',{id:-1001},true)).messageId,88);await until(async()=>await host.webContents.executeJavaScript('window.createdChats.length')===1);assert.equal(await host.webContents.executeJavaScript('window.createdChats[0]'),77);
 await resource('prompt','selectPrompt',{id:1},true);assert.equal(await host.webContents.executeJavaScript('window.prompts.selected_prompt_id'),1);
 await click('open-personas');await until(()=>settings.editor?.sectionId==='personas'&&!settings.editor.loading);
 assert.equal((await resource('personas','listPersonas')).personas[0].primary,true);
 const createdPersona=await resource('personas','createPersona',{name:'Fixture persona',description:'Description',coreMemory:'Memory',allowCoreMemoryUpdate:false},true);
 assert.equal(createdPersona.createdId,2);assert.equal(createdPersona.personas.find(item=>item.id===2).active,false);
 await resource('personas','activatePersona',{id:2},true);assert.equal(await host.webContents.executeJavaScript('window.personas.find(item=>item.id===2).is_default'),1);
 assert.equal((await resource('personas','getPersonaInstructions',{id:2})).text,'Original instructions');
 await resource('personas','savePersonaInstructions',{id:2,text:'Saved instructions'},true);
 const survey=(await resource('personas','createPersonaSurvey',{id:2,brief:'Test',questionCount:1},true)).survey;
 assert.equal(await host.webContents.executeJavaScript('window.surveyInputs.include_history'),false);assert.equal(await host.webContents.executeJavaScript('window.surveyInputs.personalize'),false);
 assert.equal((await resource('personas','answerPersonaSurvey',{id:2,surveyId:survey.id,answers:{style:'Concise'}},true)).survey.draft,'Generated instruction proposal');
 assert.equal(await host.webContents.executeJavaScript('window.instructions.text'),'Saved instructions');
 await resource('personas','applyPersonaSurvey',{id:2,surveyId:survey.id,text:'Reviewed instructions'},true);assert.equal(await host.webContents.executeJavaScript('window.instructions.text'),'Reviewed instructions');
 await resource('personas','deletePersonaSurvey',{id:2,surveyId:survey.id,removeApplied:false,confirmed:true},true);assert.equal(await host.webContents.executeJavaScript('window.instructions.surveys.length'),0);
 const personaReads=await host.webContents.executeJavaScript('window.personaReads');await js('window.sdkToggle(true)');
 await until(async()=>await js('!!document.getElementById("sdk-name-a")&&!document.getElementById("sdk-name-a").disabled&&document.getElementById("sdk-voice").textContent==="ready"'));
 assert.equal(await host.webContents.executeJavaScript('window.personaReads'),personaReads+1,'two consumers share one library fetch');
 await until(async()=>await js('!document.getElementById("sdk-choose-avatar").disabled'));
 await sleep(5500); // Chromium keeps the preceding click's transient activation for several seconds.
 assert.equal(await js('navigator.userActivation.isActive'),false);
 await assert.rejects(()=>js('window.chatter.requestSettings("personas","chooseProfileImage",{})'),/settings_request_unavailable/,'picker requires a genuine gesture');
 assert.equal(avatarPickerCalls,0);
 await click('sdk-choose-avatar');await until(async()=>await js('document.getElementById("sdk-avatar-source").textContent.startsWith("data:image/png;base64,")'));
 assert.equal(avatarPickerCalls,1);assert.equal(await host.webContents.executeJavaScript('window.avatarUploads||0'),0,'choosing does not upload');
 assert.equal(await js('document.getElementById("sdk-save-avatar").disabled'),false);
 const sourceBeforeCancel=await js('document.getElementById("sdk-avatar-source").textContent');
 avatarPickerMode='cancel';await click('sdk-choose-avatar');await until(async()=>!await js('document.getElementById("sdk-choose-avatar").disabled'));
 assert.equal(avatarPickerCalls,2);assert.equal(await js('document.getElementById("sdk-avatar-source").textContent'),sourceBeforeCancel,'cancel keeps chosen draft');
 assert.equal(await js('document.getElementById("sdk-avatar-error").textContent'),'');
 await click('sdk-save-avatar');await until(async()=>await host.webContents.executeJavaScript('window.avatarUploads')===1);
 await until(async()=>await js('document.getElementById("sdk-save-avatar").disabled'));
 await input('sdk-name-a','Unsaved SDK draft');await until(async()=>await js('document.getElementById("sdk-name-b").value')==='Unsaved SDK draft');
 assert.equal(await js('window.sdkReload()'),false,'a generic section reload must not erase structured drafts');
 await until(async()=>await js('document.getElementById("sdk-can-reload").textContent')==='false');
 assert.equal(await host.webContents.executeJavaScript('window.personas[0].name'),'Main','SDK input never saves implicitly');
 await js('window.sdkToggle(false)');await until(async()=>await js('!document.getElementById("sdk-probe")'));await js('window.sdkToggle(true)');
 await until(async()=>await js('document.getElementById("sdk-name-a")?.value')==='Unsaved SDK draft');
 await click('sdk-save-persona');await until(async()=>await host.webContents.executeJavaScript('window.personas[0].name')==='Unsaved SDK draft');
 await input('sdk-history','');assert.equal(await js('document.getElementById("sdk-save-intuition").disabled'),true,'empty numeric draft is invalid, never silently null/default');
 await input('sdk-history','4');await until(async()=>await js('!document.getElementById("sdk-save-intuition").disabled'));await click('sdk-save-intuition');await until(async()=>await host.webContents.executeJavaScript('window.intuition.settings.historyMessages')===4);
 assert.ok(settings.editors.voice&&settings.editors.personas&&settings.editors.intuition,'independent sessions coexist');
 await js('window.sdkToggle(false)');
 await host.webContents.executeJavaScript('window.account.name="Stale account read";window.delayAccountRead=new Promise(resolve=>{window.finishAccountRead=resolve});void 0');
 await click('open-account');await until(()=>settings.editor?.sectionId==='account');await js('window.chatter.reloadSettingsSection("account")');await until(()=>settings.editor.loading);
 await host.webContents.executeJavaScript('window.setSettingsMounted(false)');await until(async()=>await host.webContents.executeJavaScript('!document.getElementById("native-tokens")'));
 const readsBefore=await host.webContents.executeJavaScript('window.accountReadsReturned');await host.webContents.executeJavaScript('window.finishAccountRead()');
 await until(async()=>await host.webContents.executeJavaScript('window.accountReadsReturned')>readsBefore);
 assert.equal(await host.webContents.executeJavaScript('document.getElementById("account-name").textContent'),'Updated fixture','unmounted settings must not mutate Auth from a late read');
 await host.webContents.executeJavaScript('window.delayAccountRead=null;window.setSettingsMounted(true)');await until(()=>settings.editor===null);
 await host.webContents.executeJavaScript('window.switchSettingsAccount(2)');await until(()=>settings.editor===null);assert.equal(await host.webContents.executeJavaScript('window.ui[2].dice_roll_enabled'),false);
 assert.equal(await js('window.sdkReload()'),false,'a handler retained from an old account cannot reload the new account session');
 assert.equal(await js('[typeof electronAPI,typeof require].join(",")'),'undefined,undefined');
 console.log('PASS: ten isolated sections, headless SDK shared drafts and independent sessions, hidden-form restoration, protected reload/stale account handlers, numeric validation, native saves, credentials/reauth, surveys, host image selection with gesture checks, cancellation and explicit upload, real image cropping and legacy bridge compatibility');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{finishPreview?.(null);await sleep(10);clearTimeout(deadline);manager?.destroy();host?.destroy();app.exit(process.exitCode??0);});
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
      if (id === '\0fixture-api') return transformWithEsbuild(apiSource, 'api-fixture.ts', { loader: 'ts' });
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
    const timeout = setTimeout(() => { output += '\nSettings Electron timeout\n'; child.kill(); }, 45000);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); }); child.once('error', reject);
  });
  process.stdout.write(output); assert.equal(code, 0);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('chatter-theme-settings-'));
 fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
