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
export const state={policy:{enabled:true,allow_custom:true},servers:[{id:1,name:'GitHub',url:'https://github.example/mcp',description:'Repositories and issues',allowed:1,recommended:1}],
connections:[{id:1,name:'GitHub account',url:'https://github.example/mcp',enabled:1,mode:'search',timeout_seconds:300,has_credentials:true,blocked:false,tools:[{name:'search_repositories',description:'Search repositories'},{name:'create_issue',description:'Create an issue'}],selected_tools:null}]};
window.__calls=[];
const record=(name,body)=>window.__calls.push({name,body});
export const API_BASE='https://chatter.example';
export const getMcpState=async()=>structuredClone(state);
export const saveMcpConnection=async(body,id)=>{record('save',body);const row=state.connections.find(c=>c.id===id);if(row)Object.assign(row,body);return {};};
export const deleteMcpConnection=async(id)=>{record('delete',{id});state.connections=state.connections.filter(c=>c.id!==id);};
export const refreshMcpTools=async(id)=>{record('refresh',{id});return {tools:state.connections[0].tools};};
export const authorizeMcp=async()=>({authorization_url:'https://github.example/authorize'});
export const cancelMcp=async(id)=>{record('cancel',{id});return {cancelled:true};};
export const getMcpCatalog=async()=>({items:[{name:'Remote tools',description:'Example remote MCP server',url:'https://remote.example/mcp'}],next_cursor:null});
export const useAuth=()=>({user:{id:81}});
export const api=async(url,options={})=>{
 const body=options.body?JSON.parse(options.body):undefined;record(url,body);
 if(url.includes('/users/'))return {policy:{override:body?.override||'inherit',allow_custom:true,enabled:true},connections:state.connections};
 if(url.endsWith('/policy')){Object.assign(state.policy,body);return {policy:state.policy};}
 if(url.includes('/catalog'))return getMcpCatalog();
 return {policy:state.policy,servers:state.servers};
};
`;
fs.writeFileSync(path.join(dir, 'fixture.js'), fixture);
const entry = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import i18next from 'i18next';
import {initReactI18next} from 'react-i18next';
import {McpSettings} from 'DESKTOP_COMPONENT';
import {McpPage} from 'ADMIN_COMPONENT';
import {McpUserCard} from 'USER_COMPONENT';
import desktop from 'DESKTOP_LOCALE';
import admin from 'ADMIN_LOCALE';
i18next.use(initReactI18next).init({lng:'ru',resources:{ru:{translation:{...desktop,mcp:{...desktop.mcp,...admin.mcp}}}},initImmediate:false});
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const root=createRoot(document.getElementById('app'));
window.renderFixture=kind=>root.render(<QueryClientProvider client={client}>{kind==='desktop'?<McpSettings/>:kind==='admin'?<McpPage/>:<McpUserCard userId={81}/>}</QueryClientProvider>);
window.renderFixture('desktop');
`
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
 const until=async(code)=>{for(let n=0;n<100;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI condition: '+code)};
 const click=async(text)=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');};
 await until('document.body.innerText.includes("GitHub account")');
 assert.equal(await js('getComputedStyle(document.querySelector("section")).borderWidth'),'1px','real component styles are applied');
 await click('Обновить инструменты');
 await until('window.__calls.some(c=>c.name==="refresh")');
 await js('document.querySelector("input[type=checkbox]").click()');
 await until('window.__calls.some(c=>c.name==="save"&&c.body.enabled===false)');
 await click('Найти');
 await until('document.body.innerText.includes("Remote tools")');
 if(process.env.MCP_UI_SCREENSHOT_DIR){await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-desktop.png'),(await wc.capturePage()).toPNG());}
 await js('window.renderFixture("admin")');
 await until('document.body.innerText.includes("Политика доступа")');
 await js('document.querySelector("button[role=switch]").click()');
 await until('window.__calls.some(c=>c.name==="/api/mcp/policy"&&c.body.enabled===false)');
 if(process.env.MCP_UI_SCREENSHOT_DIR)fs.writeFileSync(path.join(process.env.MCP_UI_SCREENSHOT_DIR,'mcp-admin.png'),(await wc.capturePage()).toPNG());
 await js('window.renderFixture("user")');
 await until('document.body.innerText.includes("Разрешение собственных URL")');
 assert.ok(await js('document.body.innerText.includes("GitHub account")'));
 assert.deepEqual(errors,[],'no runtime component errors');
 console.log('PASS: actual React MCP desktop/admin/user components, query reload, toggles, catalog and user connections');
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
