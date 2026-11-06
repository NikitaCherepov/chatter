import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url),
  root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-mcp-ui-'));
const desktopRequire = createRequire(path.join(root, 'desktop-app/package.json'));
const styles: string[] = [];
const fixture = String.raw`
export const state={policy:{enabled:true,allow_custom:false,show_catalog:true},servers:[{id:1,name:'GitHub',url:'https://github.example/mcp',description:'Repositories and issues',allowed:1,recommended:1}],
connections:[{id:1,name:'GitHub account',url:'https://github.example/mcp',enabled:1,mode:'search',timeout_seconds:300,has_credentials:true,blocked:false,tools:[{name:'search_repositories',description:'Search repositories'},{name:'create_issue',description:'Create an issue'}],selected_tools:null,capabilities:{tools:true,resources:true},resources:[{name:'Guide',uri:'notes://guide'}],resource_templates:[]}]};
window.__calls=[];
const access={allow_custom:{mode:'none',user_ids:[],excluded_user_ids:[]},show_catalog:{mode:'all',user_ids:[],excluded_user_ids:[]}};

const record=(name,body)=>window.__calls.push({name,body});
window.electronAPI={localMcpManage:async()=>{}};
let localEntries=[];
export const getLocalMcp=async()=>structuredClone(localEntries);
export const installLocalMcp=async input=>{
 record('local_install',input);
 const entry={id:'local-fixture',name:input.name||'Local package',source:input.package?.identifier||input.source,enabled:true,mode:'search',tools:[{name:'local_echo',description:'Local echo tool'}],resources:[],selected_tools:null,timeout_seconds:300};
 localEntries.push(entry);return structuredClone(entry);
};
export const configureLocalMcp=async(id,patch)=>{record('local_configure',{id,patch});Object.assign(localEntries.find(e=>e.id===id),patch);};
export const removeLocalMcp=async id=>{record('local_remove',{id});localEntries=localEntries.filter(e=>e.id!==id);};
export const refreshLocalMcp=async id=>{record('local_refresh',{id});};
export const resolveImageUrl=url=>url;
export const apiFetch=async(url,options)=>{record('approve',JSON.parse(options.body));return {ok:true}};
export const getApiErrorMessage=(error,fallback)=>fallback;
export const API_BASE='https://chatter.example';
let mcpUpdate;
export const onMcpSettingsUpdated=fn=>{mcpUpdate=fn;return()=>{mcpUpdate=undefined}};
export const onBackendRestored=()=>()=>{};
window.emitMcpUpdate=()=>mcpUpdate?.();

export const getMcpState=async()=>{record('state',{});return structuredClone(state)};
export const saveMcpConnection=async(body,id)=>{record('save',body);const row=state.connections.find(c=>c.id===id);if(row)Object.assign(row,body);return {};};
export const deleteMcpConnection=async(id)=>{record('delete',{id});state.connections=state.connections.filter(c=>c.id!==id);};
export const refreshMcpTools=async(id)=>{record('refresh',{id});return {tools:state.connections[0].tools};};
export const authorizeMcp=async()=>({authorization_url:'https://github.example/authorize'});
export const cancelMcp=async(id)=>{record('cancel',{id});return {cancelled:true};};
export const mergeMcpCatalog=(previous,next)=>Array.from(new Map([...previous,...next].map(x=>[x.name+'|'+x.url,x])).values());
export const getMcpCatalog=async()=>{record('catalog',{});return {items:[{name:'Remote tools',title:'Remote tools',description:'Example remote MCP server',url:'https://remote.example/mcp',version:'2.0',transport:'streamable-http',publisher:'example',repository_url:'https://github.com/example/mcp',registry_url:'https://registry.example/server'},{name:'Local package',description:'A local package',url:'',transport:'stdio',version:'1.0.0',package:{registryType:'npm',identifier:'@example/local',version:'1.0.0',transport:{type:'stdio'}}},{name:'Configured package',description:'Requires a key',url:'',transport:'stdio',version:'1.0.0',package:{registryType:'npm',identifier:'@example/configured',version:'1.0.0',transport:{type:'stdio'},environmentVariables:[{name:'TEST_SECRET',description:'Fixture secret',isRequired:true,isSecret:true}]}}],next_cursor:null};};
window.__state=state;

export const useAuth=()=>({user:{id:81}});
export const api=async(url,options={})=>{
 const body=options.body?JSON.parse(options.body):undefined;record(url,body);
 if(url==='/api/model-access-users')return {users:[{id:81,name:'Alice',role:'user',is_admin:false},{id:82,name:'Bob',role:'user',is_admin:false}]};
 if(url==='/api/mcp/access'){if(body)Object.assign(access,body);return {access:structuredClone(access)};}
 if(url.includes('/users/'))return {policy:{override:body?.override||'inherit',allow_custom:true,enabled:true,show_catalog:state.policy.show_catalog,catalog_override:body?.catalog_override||'inherit'},connections:state.connections};
 if(url.endsWith('/policy')){Object.assign(state.policy,body);return {policy:state.policy};}
 if(url.includes('/catalog'))return getMcpCatalog();
 return {policy:state.policy,servers:state.servers};
};
`;
fs.writeFileSync(path.join(dir, 'fixture.js'), fixture);
const entry = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {McpConfirmationCard} from 'CARD_COMPONENT';
import {ConfirmationQueue} from 'QUEUE_COMPONENT';
import {useQueryClient} from '@tanstack/react-query';
import {QueryProvider} from 'QUERY_PROVIDER';
import i18next from 'i18next';
import {initReactI18next} from 'react-i18next';
import {McpSettings} from 'DESKTOP_COMPONENT';
import {McpPage} from 'ADMIN_COMPONENT';
import {McpUserCard} from 'USER_COMPONENT';
import desktop from 'DESKTOP_LOCALE';
import admin from 'ADMIN_LOCALE';
i18next.use(initReactI18next).init({lng:'ru',resources:{ru:{translation:{...desktop,mcp:{...desktop.mcp,...admin.mcp,design:{...desktop.mcp.design,...admin.mcp.design}}}}},initImmediate:false});
const root=createRoot(document.getElementById('app'));
function CardFixture(){
 const [items,setItems]=React.useState([1,2,3]);
 const composer={comment:null,request:target=>{window.__comment=target},cancel(){},change(){},submit:async()=>{},busy:false,registerReject:()=>()=>{}};
 return <ConfirmationQueue items={items.map(n=><McpConfirmationCard key={n} id={'card-'+n} title="MCP approval" summary={'tool-'+n} confirmation={{confirmation_id:'card-'+n,connection_id:1,server_name:'Fixture MCP',target:'tool-'+n,operation:'tool',arguments:{text:'review this'}}} onResolved={id=>setItems(rows=>rows.filter(n=>'card-'+n!==id))}/>)} order={new Map([['card-1',1],['card-2',2],['card-3',3]])} composer={composer}/>;
}
function Content({kind}){
 const client=useQueryClient(); window.__queryClient=client;
 return kind==='card'?<CardFixture/>:kind==='desktop'?<McpSettings/>:kind==='admin'?<McpPage/>:<McpUserCard userId={81}/>;
}
window.renderFixture=kind=>root.render(<QueryProvider><Content kind={kind}/></QueryProvider>);
window.renderFixture('desktop');
`
  .replace('CARD_COMPONENT',path.join(root,'desktop-app/src/renderer/components/McpConfirmationCard.tsx').split(path.sep).join('/'))
  .replace('QUEUE_COMPONENT',path.join(root,'desktop-app/src/renderer/components/ConfirmationCard.tsx').split(path.sep).join('/'))
  .replace(
    'QUERY_PROVIDER',
    path.join(root, 'desktop-app/src/renderer/lib/QueryProvider.tsx').replaceAll('\\', '/'),
  )
  .replace(
    'DESKTOP_COMPONENT',
    path.join(root, 'desktop-app/src/renderer/components/McpSettings.tsx').replaceAll('\\', '/'),
  )
  .replace(
    'ADMIN_COMPONENT',
    path.join(root, 'admin-panel/components/pages/McpPage/McpPage.tsx').replaceAll('\\', '/'),
  )
  .replace(
    'USER_COMPONENT',
    path.join(root, 'admin-panel/components/pages/McpPage/McpUserCard.tsx').replaceAll('\\', '/'),
  )
  .replace(
    'DESKTOP_LOCALE',
    path
      .join(root, 'desktop-app/src/renderer/i18n/locales/ru/translation.json')
      .replaceAll('\\', '/'),
  )
  .replace(
    'ADMIN_LOCALE',
    path.join(root, 'admin-panel/i18n/locales/ru/translation.json').replaceAll('\\', '/'),
  );
await require('../../node_modules/esbuild').build({
  stdin: { contents: entry, loader: 'tsx', resolveDir: path.join(root, 'desktop-app') },
  outfile: path.join(dir, 'ui.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
  plugins: [
    {
      name: 'fixtures',
      setup(builder: any) {
        builder.onResolve(
          {
            filter:
              /^(react($|\/)|react-dom($|\/)|react-i18next$|i18next$|@tanstack\/react-query$)/,
          },
          (args: any) => ({ path: desktopRequire.resolve(args.path) }),
        );
        builder.onResolve({ filter: /(mcp-service|\/auth|\/api)$/ }, () => ({
          path: path.join(dir, 'fixture.js'),
        }));
        builder.onLoad({ filter: /\.(scss|css)$/ }, (args: any) => {
          const css = args.path.endsWith('.scss')
            ? desktopRequire('sass').compile(args.path, { logger: { warn() {}, debug() {} } }).css
            : fs.readFileSync(args.path, 'utf8');
          const prefix = 'fixture' + styles.length + '_';
          const classes = Object.fromEntries(
            [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => [match[1], prefix + match[1]]),
          );
          styles.push(css.replace(/\.([a-zA-Z_][\w-]*)/g, (full, name) => '.' + classes[name]));
          return { contents: 'export default ' + JSON.stringify(classes), loader: 'js' };
        });
      },
    },
  ],
});
const adminCss = fs
  .readFileSync(path.join(root, 'admin-panel/app/globals.css'), 'utf8')
  .replace(/@import\s+url\([^)]*\);/g, '');
const globalCss = desktopRequire('sass')
  .compile(path.join(root, 'desktop-app/src/renderer/global.scss'), {
    logger: { warn() {}, debug() {} },
  })
  .css.replace(/@import\s+url\([^)]*\);/g, '');
fs.writeFileSync(
  path.join(dir, 'index.html'),
  '<meta charset="utf-8"><style>' +
    adminCss +
    globalCss +
    styles.join('\n') +
    'body{padding:24px;max-width:1000px;margin:auto}button,input{font:inherit}code{overflow-wrap:anywhere}</style><div id="app"></div><script src="./ui.js"></script>',
);
fs.writeFileSync(
  path.join(dir, 'main.cjs'),
  String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
app.commandLine.appendSwitch('disable-gpu');
let win;const errors=[];
(async()=>{
 await app.whenReady();
 win=new BrowserWindow({show:false,width:1060,height:1100,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}});
 const wc=win.webContents;
 wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
 await win.loadFile(path.join(__dirname,'index.html'));
 const js=code=>wc.executeJavaScript(code);
 const until=async(code,attempts=100)=>{for(let n=0;n<attempts;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI condition: '+code)};
 const click=async(text)=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.getClientRects().length&&b.textContent.trim()==='+JSON.stringify(text)+').click()');};
 await until('document.body.innerText.includes("Рекомендованные")');
 if(process.env.MCP_UI_SCREENSHOT_DIR) {
   await new Promise(r=>setTimeout(r,250));
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-catalog-light.png'),(await wc.capturePage()).toPNG());
   await js('document.documentElement.dataset.theme="dark"');
   await new Promise(r=>setTimeout(r,250));
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-catalog-dark.png'),(await wc.capturePage()).toPNG());
   await js('document.documentElement.dataset.theme="light"');
 }
 await click('Подключённые');
 await until('document.body.innerText.includes("GitHub account")');
 assert.equal(await js('getComputedStyle(document.querySelector("section[class*=connection]")).borderWidth'),'1px','real component styles are applied');
 await click('Обновить возможности');
 await js('document.querySelector("section[class*=connection] summary").click()');
 await js('document.querySelectorAll("section[class*=connection] > details > summary")[3].click()');
 await until('window.__calls.some(c=>c.name==="refresh")');
 await js('Array.from(document.querySelectorAll("button[role=switch]")).find(b=>document.getElementById(b.getAttribute("aria-labelledby"))?.textContent.trim()==="Без подтверждения").click()');
 await until('window.__calls.some(c=>c.name==="save"&&c.body.approval_policy?.tools.includes("search_repositories"))');
 await until('!Array.from(document.querySelectorAll("button[role=switch]")).find(b=>document.getElementById(b.getAttribute("aria-labelledby"))?.textContent.trim()==="Без подтверждения").disabled');
 await js('Array.from(document.querySelectorAll("button[role=switch]")).find(b=>document.getElementById(b.getAttribute("aria-labelledby"))?.textContent.trim()==="Без подтверждения").click()');
 await until('window.__calls.some(c=>c.name==="save"&&c.body.approval_policy?.tools.length===0)');
 if(process.env.MCP_UI_SCREENSHOT_DIR){
   await new Promise(r=>setTimeout(r,250));
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-tools-light.png'),(await wc.capturePage()).toPNG());
   await js('document.documentElement.dataset.theme="dark"');
   await new Promise(r=>setTimeout(r,250));
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-tools-dark.png'),(await wc.capturePage()).toPNG());
   await js('document.documentElement.dataset.theme="light"');
 }
 await js('document.querySelector("button[role=switch]").click()');
 await until('window.__calls.some(c=>c.name==="save"&&c.body.enabled===false)');
 if(process.env.MCP_UI_SCREENSHOT_DIR){await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-connected.png'),(await wc.capturePage()).toPNG());}
 await click('Каталог MCP');
 assert.equal(await js('document.body.innerText.includes("Remote tools")'),false,'desktop shows approved servers only');
 assert.ok(await js('!!document.querySelector(\'a[href="https://github.example/mcp"]\')'));
 await js('(()=>{const input=document.querySelector(\'input[aria-label="Найти"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"unknown");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await until('document.body.innerText.includes("Одобренных серверов по этому запросу нет.")');
 await js('(()=>{const input=document.querySelector(\'input[aria-label="Найти"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 const callsBeforeHide=await js('window.__calls.filter(c=>c.name==="catalog").length');
 assert.equal(callsBeforeHide,0,'desktop never requests public Registry');
 await js('window.__queryClient.setQueryData(["chats","https://chatter.example",81],[]);window.__queryClient.setQueryData(["settings","https://chatter.example",81,"models"],{});window.__state.policy.show_catalog=false;window.emitMcpUpdate()');
 await until('!document.body.innerText.includes("Каталог MCP")');
 assert.ok(await js('document.body.innerText.includes("GitHub account")'));
 assert.equal(await js('!!document.querySelector(\'input[aria-label="Найти"]\')'),false);
 assert.equal(await js('window.__calls.filter(c=>c.name==="catalog").length'),0);
 await js('window.__state.policy.show_catalog=true;window.__state.servers[0].description="Updated by admin";window.emitMcpUpdate()');
 await click('Каталог MCP');
 await until('document.body.innerText.includes("Updated by admin")');
 assert.equal(await js('window.__queryClient.getQueryState(["chats","https://chatter.example",81]).isInvalidated'),false,'MCP event does not invalidate chats');
 assert.equal(await js('window.__queryClient.getQueryState(["settings","https://chatter.example",81,"models"]).isInvalidated'),false,'MCP event does not invalidate other settings');
 assert.equal(await js('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Обновить настройки")'),false);
 const options=await js('(()=>{const q=window.__queryClient.getQueryCache().find({queryKey:["settings","https://chatter.example",81,"mcp"]});return {staleTime:q.options.staleTime,polling:!!q.options.refetchInterval}})()');
 assert.equal(options.staleTime,60000,'same shared settings cache policy');
 assert.equal(options.polling,false,'no independent polling timer');

 await js('window.__state.policy.allow_custom=true;window.emitMcpUpdate()');
 await until('document.body.innerText.includes("Собственные MCP разрешены.")');
 await js('(()=>{const input=document.querySelector(\'input[aria-label="Найти"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"Sentry");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await click('Найти');
 await until('document.body.innerText.includes("Remote tools")');
 if(process.env.MCP_UI_SCREENSHOT_DIR){
   await js('Array.from(document.querySelectorAll("[class*=catalogCard] > details > summary")).forEach(summary=>summary.click())');
   await new Promise(r=>setTimeout(r,300));
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-registry-light.png'),(await wc.capturePage()).toPNG());
 }
 assert.ok(await js('!!document.querySelector(\'a[href="https://github.com/example/mcp"]\')'));
 await js('Array.from(document.querySelectorAll("strong")).find(e=>e.textContent==="Local package").closest("[class*=catalogCard]").querySelector("button").click()');
 assert.ok(await js('(()=>{const form=document.querySelector("[class*=addPanel]");const connection=document.querySelector("section[class*=connection]");return !!form&&!!connection&&!!(form.compareDocumentPosition(connection)&Node.DOCUMENT_POSITION_FOLLOWING)})()'),'add form precedes connected MCP cards');
 if(process.env.MCP_UI_SCREENSHOT_DIR){await new Promise(r=>setTimeout(r,300));await js('document.querySelector("[class*=addPanel]").scrollIntoView({block:"start"})');fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-add-top.png'),(await wc.capturePage()).toPNG());}
 await click('Установить на ПК');
 await until('window.__calls.some(c=>c.name==="local_install"&&c.body.package.identifier==="@example/local")');
 await until('document.querySelector("article")?.textContent.includes("Local package")');
 if(process.env.MCP_UI_SCREENSHOT_DIR){await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-local-connected.png'),(await wc.capturePage()).toPNG());}
 await js('document.querySelector("article summary").click()');
 await js('Array.from(document.querySelector("article").querySelectorAll("button[role=switch]")).find(b=>document.getElementById(b.getAttribute("aria-labelledby"))?.textContent.trim()==="Не запрашивать подтверждения для этого MCP").click()');
 await until('window.__calls.some(c=>c.name==="local_configure"&&c.body.patch.approval_policy?.allow_all===true)');
 await until('!document.querySelector("article button[role=switch]").disabled');
 await js('document.querySelector("article button[role=switch]").click()');
 await until('window.__calls.some(c=>c.name==="local_configure"&&c.body.patch.enabled===false)');
 await js('Array.from(document.querySelector("article").querySelectorAll("button")).find(b=>b.textContent==="Удалить").click()');
 await until('document.body.innerText.includes("Удалить локальный MCP?")');
 await js('Array.from(document.querySelectorAll("button")).find(b=>b.className.includes("confirmDanger")).click()');
 await until('window.__calls.some(c=>c.name==="local_remove")');
 await until('!document.querySelector("article")');
 await click('Каталог MCP');
 await js('Array.from(document.querySelectorAll("strong")).find(e=>e.textContent==="Configured package").closest("[class*=catalogCard]").querySelector("button").click()');
 await until('document.body.innerText.includes("Fixture secret")');
 await js('(()=>{const input=Array.from(document.querySelectorAll("label")).find(e=>e.textContent.trim()==="Fixture secret").querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"test-value");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await click('Установить на ПК');
 await until('window.__calls.some(c=>c.name==="local_install"&&c.body.package.identifier==="@example/configured"&&c.body.values["env:TEST_SECRET"]==="test-value")');
 await click('Каталог MCP');
 await click('Подключить');
 await until('document.querySelector(\'input[type="url"]\')?.value==="https://remote.example/mcp"');
 await js('window.__state.policy.allow_custom=false;window.emitMcpUpdate()');
 await until('!document.body.innerText.includes("Remote tools")&&!document.querySelector(\'input[type="url"]\')');
 if(process.env.MCP_UI_SCREENSHOT_DIR){await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-desktop.png'),(await wc.capturePage()).toPNG());}
 await js('window.renderFixture("admin")');
 await until('document.body.innerText.includes("Политика доступа")');
 await click('Найти');
 await until('document.body.innerText.includes("Remote tools")');
 assert.ok(await js('!!document.querySelector(\'a[href="https://github.com/example/mcp"]\')'));

 await js('window.__state.policy.show_catalog=false;window.emitMcpUpdate()');
 await js('window.renderFixture("desktop")');
 await until('document.body.innerText.includes("GitHub account")&&!document.body.innerText.includes("Каталог MCP")');
 await js('window.renderFixture("admin")');
 await until('document.body.innerText.includes("Политика доступа")');
 await js('document.querySelector("button[role=switch]").click()');
 await until('window.__calls.some(c=>c.name==="/api/mcp/policy"&&c.body.enabled===false)');
 await until('!!document.querySelector(\'button[aria-label="Добавление собственных MCP"]\')');
 await js('document.querySelector(\'button[aria-label="Добавление собственных MCP"]\').click()');
 await click('Для выбранных пользователей');
 await js('document.querySelector(\'button[aria-label="Пользователи с доступом к своим MCP"]\').click()');
 await until('document.body.innerText.includes("Alice")');
 await js('Array.from(document.querySelectorAll("label")).find(x=>x.textContent.includes("Alice")).querySelector("input[type=checkbox]").click()');
 await js('document.querySelector(\'button[aria-label="Пользователи с доступом к своим MCP"]\').click()');
 await click('Сохранить');
 await until('window.__calls.some(c=>c.name==="/api/mcp/access"&&c.body?.allow_custom?.user_ids.includes(81))');
 assert.ok(await js('window.__calls.some(c=>c.name==="/api/model-access-users")'));
 await until('!document.querySelector("button[role=switch]").disabled');
 if(process.env.MCP_UI_SCREENSHOT_DIR){await js('window.scrollTo(0,0)');fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-admin.png'),(await wc.capturePage()).toPNG());}
 await js('document.querySelector("details > summary").click()');
 await until('!!document.querySelector(\'button[aria-label="Тип подключения"]\')');
 await js('document.querySelector(\'button[aria-label="Тип подключения"]\').click()');
 await click('На компьютере пользователя');
 await until('!!document.querySelector(\'input[placeholder="npx -y @playwright/mcp@latest"]\')');
 await js('(()=>{for(const [selector,value] of [["form input[maxlength=\\\"120\\\"]","Admin local"],["form input[placeholder^=\\\"npx\\\"]","npx -y @playwright/mcp@latest"]]){const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));}})()');
 if(process.env.MCP_UI_SCREENSHOT_DIR){
   await new Promise(r=>setTimeout(r,350));await js('document.querySelector("details").scrollIntoView({block:"start"})');
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-admin-add.png'),(await wc.capturePage()).toPNG());
   await js('document.documentElement.dataset.theme="dark"');await new Promise(r=>setTimeout(r,150));
   fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-admin-add-dark.png'),(await wc.capturePage()).toPNG());
   await js('document.documentElement.dataset.theme="light"');
 }
 await click('Добавить сервер');
 await until('window.__calls.some(c=>c.name==="/api/mcp/servers"&&c.body?.transport==="stdio"&&c.body.source==="npx -y @playwright/mcp@latest"&&c.body.recommended===true&&c.body.allowed===true)');

 await js('window.renderFixture("user")');
 await until('document.body.innerText.includes("GitHub account")');
 assert.equal(await js('document.querySelectorAll("button").length'),0,"user card has no duplicate access editor");
 assert.ok(await js('document.body.innerText.includes("GitHub account")'));
 await js('window.renderFixture("card")');
 await until('document.body.innerText.includes("Fixture MCP")');
 assert.ok(await js('document.body.innerText.includes("review this")'),'arguments visible');
 await click('Разрешить');
 await until('window.__calls.some(c=>c.name==="approve"&&c.body.confirmation_id==="card-1"&&c.body.approved===true&&c.body.remember_mcp===false)');
 await until('document.body.innerText.includes("tool-2")');
 await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Отклонить с комментарием")).click()');
 assert.ok(await js('!!window.__comment'),'uses composer comment flow');
 await js('window.__comment.reject("Please stop")');
 await until('window.__calls.some(c=>c.name==="approve"&&c.body.confirmation_id==="card-2"&&c.body.rejection_comment==="Please stop")');
 await until('document.body.innerText.includes("tool-3")');
 await js('document.querySelector("details summary").click()');
 await click('Всегда разрешать этот инструмент');
 await until('window.__calls.some(c=>c.name==="approve"&&c.body.confirmation_id==="card-3"&&c.body.remember_mcp===true)');
 await until('!document.querySelector("[data-confirmation-id]")');
 assert.deepEqual(errors,[],'no runtime component errors');
 console.log('PASS: React MCP settings, grant/revoke, native permissions, confirmation queue buttons and composer comments, catalog and admin access');
})().catch(e=>{console.error(e,errors);process.exitCode=1}).finally(()=>{win?.destroy();app.exit(process.exitCode||0)});
`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(desktopRequire('electron'), [path.join(dir, 'main.cjs')], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP UI timeout'));
    }, 30000);
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
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('chatter-mcp-ui-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
