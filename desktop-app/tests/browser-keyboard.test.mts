import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-keyboard-test-'));
const esbuild = require('../node_modules/esbuild');
for (const [source, output] of [['cursor-input', 'cursor'], ['browser', 'browser']]) {
  esbuild.buildSync({ entryPoints: [fileURLToPath(new URL('../src/main/' + source + '.ts', import.meta.url))],
    outfile: path.join(dir, output + '.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
}
fs.writeFileSync(path.join(dir, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {typeHumanText,pressHumanKey}=require('./cursor.cjs');
const {ChatterBrowser}=require('./browser.cjs');
app.commandLine.appendSwitch('disable-gpu');
let win;
(async()=>{
 await app.whenReady();
 win=new BrowserWindow({show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
 await win.loadURL('data:text/html,'+encodeURIComponent('<main><p>Baseline</p><textarea style="width:300px;height:100px" placeholder="Ask anything"></textarea></main>'));
 const wc=win.webContents;
 const execute=code=>wc.executeJavaScriptInIsolatedWorld(1004,[{code}],true);
 const reset=async(value='')=>{
   await wc.executeJavaScript('(()=>{const e=document.querySelector("textarea");e.value='+JSON.stringify(value)+';e.focus();window.enters=0;window.keys=[]})()');
   await execute('globalThis.__cb_e=new Map([["field",document.querySelector("textarea")]]);void 0');
 };
 const value=()=>wc.executeJavaScript('document.querySelector("textarea").value');
 await wc.executeJavaScript('document.addEventListener("keydown",e=>{window.keys.push("down:"+e.key);if(e.key==="Enter")window.enters++;});document.addEventListener("keyup",e=>window.keys.push("up:"+e.key));void 0');
 Math.random=()=>0;
 await reset();
 const unicode='A😀Б👩‍💻B';
 await typeHumanText(wc,unicode);assert.equal(await value(),unicode,'single-character typing preserves Unicode');
 await reset();
 const long='a😀'.repeat(40);
 await typeHumanText(wc,long,{budgetMs:1500});assert.equal(await value(),long,'merged bursts preserve surrogate pairs');
 await reset();
 const token={cancelled:false};
 const timer=setTimeout(()=>{token.cancelled=true},80);
 await assert.rejects(()=>typeHumanText(wc,'abcd',{},token),/fill_cancelled/);clearTimeout(timer);
 assert.equal(await value(),'','cancellation during pre-insert delay must not insert another character');

 await reset();
 const held={cancelled:false};
 await wc.executeJavaScript('document.querySelector("textarea").onkeydown=e=>{if(e.key==="a")console.log("held-key")};void 0');
 const cancelHeld=(_event,_level,message)=>{if(message==='held-key')held.cancelled=true};
 wc.on('console-message',cancelHeld);
 await assert.rejects(()=>typeHumanText(wc,'a',{},held),/fill_cancelled/);
 wc.removeListener('console-message',cancelHeld);
 assert.equal(await value(),'','cancellation between keyDown and insertText prevents insertion');
 assert.deepEqual(await wc.executeJavaScript('window.keys'),['down:a','up:a'],'cancelled held key is released');
 await wc.executeJavaScript('document.querySelector("textarea").onkeydown=null;void 0');

 await reset();
 const enterToken={cancelled:false};
 const enterTimer=setTimeout(()=>{enterToken.cancelled=true},20);
 await assert.rejects(()=>pressHumanKey(wc,'Enter',enterToken),/fill_cancelled/);clearTimeout(enterTimer);
 assert.equal(await wc.executeJavaScript('window.enters'),0,'cancelled reaction delay must not press Enter');

 // Exercise the actual fill method against a local native textarea.
 const browser=Object.create(ChatterBrowser.prototype);
 Object.assign(browser,{view:{webContents:wc},interactionInProgress:false,googleAiRunId:0,googleAiInProgress:false,
   getSnapshotTarget:()=>({element:{tag:'textarea',sensitive:false},frame:{},internalRef:'field'}),
   executeInFrameIsolated:(_frame,code)=>execute(code),executeInBrowserWorld:execute,
   getState:()=>({}),navigateToUrl:async()=>{},ensureReadablePage:async()=>{}});
 await reset('   ');
 await browser.fillElement('field','new value');
 assert.equal(await value(),'new value','fill replaces existing whitespace');
 await browser.fillElement('field','');
 assert.equal(await value(),'','fill with empty text clears through native input');
 await browser.fillElement('field','  exact  value  ');
 assert.equal(await value(),'  exact  value  ','fill preserves requested whitespace exactly');

 // Run the actual Google AI submission method on the local page; no external requests.
 await reset();
 await wc.executeJavaScript('document.querySelector("textarea").oninput=()=>console.log("cancel-google");void 0');
 const cancelGoogle=(_event,_level,message)=>{if(message==='cancel-google')browser.cancelGoogleAi()};
 wc.on('console-message',cancelGoogle);
 await assert.rejects(()=>browser.googleAi({action:'ask',message:'Never submit after cancellation'}),/fill_cancelled|google_ai_cancelled/);
 wc.removeListener('console-message',cancelGoogle);
 assert.equal(await wc.executeJavaScript('window.enters'),0,'cancelled Google AI run never submits Enter');
 assert.equal(browser.googleAiInProgress,false);

 // The retry path also shares the run's cancellation token.
 await reset();
 const retryMessage='test';
 await wc.executeJavaScript('window.inputCount=0;document.querySelector("textarea").onkeydown=e=>{if(e.key==="Enter")e.preventDefault()};document.querySelector("textarea").oninput=()=>{if(++window.inputCount>4)console.log("cancel-google-retry")};void 0');
 const cancelRetry=(_event,_level,message)=>{if(message==='cancel-google-retry')browser.cancelGoogleAi()};
 wc.on('console-message',cancelRetry);
 await assert.rejects(()=>browser.googleAi({action:'ask',message:retryMessage}),/fill_cancelled|google_ai_cancelled/);
 wc.removeListener('console-message',cancelRetry);
 assert.equal(await wc.executeJavaScript('window.enters'),1,'cancelled retry must not press a second Enter');
 assert.equal(browser.googleAiInProgress,false);
 console.log('PASS: real Electron Unicode characters/bursts, cancellation before insertion/Enter, key release, exact fill/empty clear and cancelled Google AI submission');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{win?.destroy();app.exit(process.exitCode||0)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron keyboard test timed out')); }, 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', value => { clearTimeout(timer); resolve(value); });
  });
  process.stdout.write(output); assert.equal(code, 0);
} finally {
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('chatter-keyboard-test-'));
  fs.rmSync(target, { recursive: true, force: true });
}
