import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-browser-startup-'));
require('../node_modules/esbuild').buildSync({
  entryPoints: [fileURLToPath(new URL('../src/main/browser.ts', import.meta.url))],
  outfile: path.join(dir, 'browser.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
});
fs.writeFileSync(path.join(dir, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');
const http=require('node:http'),assert=require('node:assert/strict');
const {ChatterBrowser}=require('./browser.cjs');
app.commandLine.appendSwitch('disable-gpu');
let host,server;const browsers=[],requests=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){
 const deadline=Date.now()+8000;
 while(!await test()){if(Date.now()>deadline)throw Error('browser startup/navigation timed out');await sleep(25)}
}
(async()=>{
 await app.whenReady();
 server=http.createServer((req,res)=>{requests.push({url:req.url,ua:req.headers['user-agent']});res.setHeader('Content-Type','text/html');res.end('<title>Startup OK</title><h1>Local browser works</h1>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 host=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 await host.loadURL('data:text/html,Host');
 // Fresh native view, full real constructor, profile initialization and panel opening.
 const browser=new ChatterBrowser(host,{homeUrl:base+'/home',partition:'startup-visible-'+Date.now()});browsers.push(browser);
 browser.setVisible(true,{x:0,y:0,width:800,height:600},'test');
 await until(()=>browser.getState().title==='Startup OK'&&!browser.getState().isLoading);
 assert.equal(browser.getState().url,base+'/home');
 assert.equal(await browser.view.webContents.executeJavaScript('document.querySelector("h1").textContent'),'Local browser works');
 await browser.control({action:'open',url:base+'/second'});
 await until(()=>browser.getState().url===base+'/second'&&!browser.getState().isLoading);
 // Background tools start with about:blank and navigate explicitly.
 const hidden=new ChatterBrowser(host,{homeUrl:'about:blank',partition:'startup-background-'+Date.now(),backgroundSize:{width:800,height:600}});browsers.push(hidden);
 await hidden.control({action:'open',url:base+'/background'});
 await until(()=>hidden.getState().title==='Startup OK'&&!hidden.getState().isLoading);
 assert.equal(hidden.getState().url,base+'/background');
 assert.ok(requests.some(r=>r.url==='/home'),'home navigation must start');
 assert.ok(requests.some(r=>r.url==='/background'),'background navigation must start');
 for(const req of requests)assert.ok(!/Electron|chatter/i.test(req.ua),'remote requests keep the cleaned browser profile');
 console.log('PASS: fresh WebContentsView startup, visible panel state, loaded document, subsequent and background navigation');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 for(const browser of browsers)browser.destroy();
 host?.destroy();
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
 app.exit(process.exitCode||0);
});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron startup test timed out')); }, 35_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', value => { clearTimeout(timer); resolve(value); });
  });
  process.stdout.write(output); assert.equal(code, 0);
} finally {
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('chatter-browser-startup-'));
  fs.rmSync(target, { recursive: true, force: true });
}
