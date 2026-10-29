import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const esbuild = require('../node_modules/esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-browser-hover-'));
esbuild.buildSync({ entryPoints: [fileURLToPath(new URL('../src/main/browser-visual.ts', import.meta.url))], outfile: path.join(dir, 'visual.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
fs.writeFileSync(path.join(dir, 'test.cjs'), String.raw`
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),http=require('node:http');
const {BrowserVisualSession}=require('./visual.cjs');
app.commandLine.appendSwitch('disable-gpu');
let win,server;
(async()=>{
 await app.whenReady();
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>body{margin:0;height:2000px}button{position:absolute;left:200px;top:140px;width:120px;height:70px}</style><button onclick="window.hits=(window.hits||0)+1"><span>Click me</span></button>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({width:800,height:650,show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
 const wc=win.webContents;await win.loadURL('http://127.0.0.1:'+server.address().port);await new Promise(r=>setTimeout(r,100));
 const execute=code=>wc.executeJavaScriptInIsolatedWorld(1004,[{code}],true);
 const visual=new BrowserVisualSession(wc,execute);
 const point=()=>execute('(()=>{const r=document.querySelector("button").getBoundingClientRect();return{x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight}})()');
 const prepare=async handler=>{
   wc.sendInputEvent({type:'mouseMove',x:0,y:0});await new Promise(r=>setTimeout(r,30));
   await wc.executeJavaScript('document.querySelector("button").onmouseenter='+handler+';void 0');
   return {shot:await visual.capture(),p:await point()};
 };

 await wc.executeJavaScript('document.addEventListener("click",e=>{window.lastClick={x:e.clientX,y:e.clientY,target:e.target.id||e.target.tagName,cursorVisible:document.getElementById("__cb-c")?.style.opacity,cursorX:parseFloat(document.getElementById("__cb-c")?.style.left),cursorY:parseFloat(document.getElementById("__cb-c")?.style.top)}})');
 const press=async run=>{
   await visual.click(run.shot.snapshot_id,run.p.x,run.p.y,{x:0,y:0},{cancelled:false});
   const actual=await wc.executeJavaScript('window.lastClick');
   assert.ok(Math.abs(actual.x-run.p.x*run.shot.viewport_width)<=1);
   assert.ok(Math.abs(actual.y-run.p.y*run.shot.viewport_height)<=1);
   assert.equal(actual.cursorVisible,'1','shared cursor overlay is visible during native click');
   assert.ok(Math.abs(actual.cursorX-actual.x)<=1,'overlay follows the same target with zoom applied');
   assert.ok(Math.abs(actual.cursorY-actual.y)<=1);
   assert.equal(await execute('document.getElementById("__cb-c").style.opacity'),'0','overlay is hidden after click');
   return actual;
 };
 let run=await prepare('function(){this.dataset.hovered="yes";this.innerHTML="<b>Click me</b>"}');
 await wc.executeJavaScript('document.body.dataset.changed="after screenshot"');
 await press(run);
 assert.equal(await wc.executeJavaScript('window.hits'),1,'DOM updates do not invalidate coordinates');
 await assert.rejects(()=>visual.coordinates(run.shot.snapshot_id,run.p.x,run.p.y),/browser_screenshot_stale/);
 run=await prepare('function(){this.style.left="500px"}');
 await press(run);
 assert.equal(await wc.executeJavaScript('window.hits'),1,'click stays at the original point instead of following the element');
 await wc.executeJavaScript('document.querySelector("button").style.left="200px"');
 run=await prepare('function(){const overlay=document.createElement("div");overlay.id="cover";overlay.style="position:fixed;inset:0;z-index:100";document.body.append(overlay)}');
 assert.equal((await press(run)).target,'cover','the current surface at the requested point receives the click');
 await wc.executeJavaScript('document.querySelector("#cover").remove()');
 run=await prepare('function(){this.textContent="Different action"}');
 await press(run);
 assert.equal(await wc.executeJavaScript('window.hits'),2,'changed labels do not cancel coordinate clicks');
 wc.setZoomFactor(1.25);
 run=await prepare('null');await press(run);
 wc.setZoomFactor(1);
 run=await prepare('null');await wc.executeJavaScript('scrollTo(0,100)');
 await assert.rejects(()=>visual.coordinates(run.shot.snapshot_id,run.p.x,run.p.y),/browser_screenshot_stale/);
 await wc.executeJavaScript('scrollTo(0,0)');
 run=await prepare('null');wc.setZoomFactor(1.25);
 await assert.rejects(()=>visual.coordinates(run.shot.snapshot_id,run.p.x,run.p.y),/browser_screenshot_stale/);
 wc.setZoomFactor(1);
 run=await prepare('null');win.setSize(900,650);await new Promise(r=>setTimeout(r,100));
 await assert.rejects(()=>visual.coordinates(run.shot.snapshot_id,run.p.x,run.p.y),/browser_screenshot_stale/);
 run=await prepare('null');await win.loadURL(wc.getURL());
 await assert.rejects(()=>visual.coordinates(run.shot.snapshot_id,run.p.x,run.p.y),/browser_screenshot_stale/);
 await assert.rejects(()=>visual.coordinates('anything',2,.5),/browser_coordinates_out_of_range/);
 console.log('PASS: real Electron exact-point clicks despite DOM updates, hover, moved elements and overlays; zoom conversion, single-use and stale document/viewport checks');

})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(win&&!win.isDestroyed())win.destroy();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}app.exit(process.exitCode||0)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [path.join(dir, 'test.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron hover test timed out')); }, 45_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', value => { clearTimeout(timer); resolve(value); });
  });
  process.stdout.write(output); assert.equal(code, 0);
} finally {
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('chatter-browser-hover-'));
  fs.rmSync(target, { recursive: true, force: true });
}
