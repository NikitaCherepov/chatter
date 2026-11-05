import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-typing-typos-'));
require('../node_modules/esbuild').buildSync({ entryPoints: [fileURLToPath(new URL('../src/main/cursor-input.ts', import.meta.url))],
  outfile: path.join(dir, 'cursor.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
fs.writeFileSync(path.join(dir, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');
const {typeHumanText}=require('./cursor.cjs');
app.commandLine.appendSwitch('disable-gpu');
let win;
(async()=>{
 await app.whenReady();
 win=new BrowserWindow({show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 await win.loadURL('data:text/html,<textarea></textarea>');
 const wc=win.webContents;
 const reset=async()=>{
   await wc.executeJavaScript('(()=>{const e=document.querySelector("textarea");e.removeAttribute("maxlength");e.value="";e.focus();e.oninput=null;window.changes=[];window.keys=[];e.onkeydown=k=>window.keys.push("down:"+k.key);e.onkeyup=k=>window.keys.push("up:"+k.key);e.addEventListener("input",k=>window.changes.push({value:e.value,type:k.inputType,data:k.data,time:performance.now()}),{signal:(window.recordController?.abort(),window.recordController=new AbortController(),window.recordController.signal)})})()');
 };
 const state=()=>wc.executeJavaScript('({value:document.querySelector("textarea").value,changes:window.changes,keys:window.keys})');
 // Force the rare branch deterministically; production keeps Math.random.
 Math.random=()=>.999;
 for(const expected of ['hello world','ДаПривет']){
   await reset();await typeHumanText(wc,expected);
   const actual=await state();
   assert.equal(actual.value,expected,'typo correction restores exact target text');
   assert.ok(actual.changes.some(c=>!expected.startsWith(c.value)),'a wrong letter was visibly inserted');
   assert.ok(actual.changes.some(c=>c.type==='deleteContentBackward'),'correction uses native Backspace');
   assert.ok(actual.keys.includes('down:Backspace')&&actual.keys.includes('up:Backspace'));
 }
 await reset();
 const long='a😀б'.repeat(20);
 await typeHumanText(wc,long,{});
 let actual=await state();
 assert.equal(actual.value,long,'long per-character input preserves Unicode and surrounding text');
 const inserts=actual.changes.filter(c=>c.type==='insertText');
 assert.ok(inserts.length>=Array.from(long).length,'long text is not pasted in chunks');
 assert.ok(inserts.every(c=>Array.from(c.data||'').length===1),'each real input event inserts one Unicode code point');
 assert.ok(inserts.at(-1).time-inserts[0].time>Array.from(long).length*60,'long input retains visible pauses instead of being compressed into a budget');
 const deletes=actual.changes.filter(c=>c.type==='deleteContentBackward');
 assert.equal(deletes.length,3,'errors are capped per input');
 assert.ok(!actual.value.includes('�'));

 await reset();
 await typeHumanText(wc,'12345 😀 67890');
 actual=await state();assert.equal(actual.value,'12345 😀 67890');
 assert.ok(!actual.keys.includes('down:Backspace'),'numbers and emoji never receive invented typos');

 await reset();
 await typeHumanText(wc,'no mistakes',{typos:false});
 actual=await state();assert.equal(actual.value,'no mistakes');
 assert.ok(!actual.keys.includes('down:Backspace'),'callers can disable the effect');

 await reset();
 await wc.executeJavaScript('document.querySelector("textarea").maxLength=3;void 0');
 await typeHumanText(wc,'abc');
 assert.equal((await state()).value,'abc','correction works at maxlength without adding an extra character');

 await reset();
 let progress=0;
 await typeHumanText(wc,'Мгновенно 😀',{humanTyping:false,onProgress:()=>progress++});
 actual=await state();
 assert.equal(actual.value,'Мгновенно 😀');
 assert.equal(actual.changes.filter(c=>c.type==='insertText').length,1,'instant mode inserts the whole value once');
 assert.equal(progress,1);
 assert.ok(!actual.keys.includes('down:Backspace'));
 await typeHumanText(wc,'replaced',{humanTyping:false,clearFirst:true});
 assert.equal((await state()).value,'replaced','instant mode replaces existing input');
 await assert.rejects(()=>typeHumanText(wc,'forbidden',{humanTyping:false},{cancelled:true}),/fill_cancelled/);
 assert.equal((await state()).value,'replaced');
 await reset();
 progress=0;
 await typeHumanText(wc,'abc',{typos:false,onProgress:()=>progress++});
 assert.equal(progress,3,'progress follows completed characters');

 await reset();
 const token={cancelled:false};
 await wc.executeJavaScript('document.querySelector("textarea").oninput=()=>{if(!"abcdef".startsWith(document.querySelector("textarea").value))console.log("cancel-typo")};void 0');
 const cancel=(_event,_level,message)=>{if(message==='cancel-typo')token.cancelled=true};
 wc.on('console-message',cancel);
 await assert.rejects(()=>typeHumanText(wc,'abcdef',{},token),/fill_cancelled/);
 wc.removeListener('console-message',cancel);
 actual=await state();
 assert.ok(!actual.keys.includes('down:Backspace'),'abort during recognition delay prevents later correction');
 const stopped=actual.value;
 await new Promise(r=>setTimeout(r,100));
 assert.equal((await state()).value,stopped,'no delayed edits continue after cancellation');
 console.log('PASS: visible Latin/Cyrillic mistakes, native Backspace, exact completion, per-character long Unicode input, error cap, digits, maxlength and cancellation');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{win?.destroy();app.exit(process.exitCode||0)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron typo test timed out')); }, 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', value => { clearTimeout(timer); resolve(value); });
  });
  process.stdout.write(output); assert.equal(code, 0);
} finally {
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('chatter-typing-typos-'));
  fs.rmSync(target, { recursive: true, force: true });
}
