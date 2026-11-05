import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-identity-test-'));
for (const source of ['browser', 'browser-identity']) {
  require('../node_modules/esbuild').buildSync({
    entryPoints: [fileURLToPath(new URL('../src/main/' + source + '.ts', import.meta.url))],
    outfile: path.join(dir, source + '.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  });
}
fs.writeFileSync(path.join(dir, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron'),http=require('node:http'),assert=require('node:assert/strict');
const {ChatterBrowser}=require('./browser.cjs'),{buildBrowserIdentity}=require('./browser-identity.cjs');
app.userAgentFallback=buildBrowserIdentity(app.userAgentFallback).userAgent;
app.commandLine.appendSwitch('disable-gpu');
const browsers=[];let host,baseline,server;
const probe=async()=>({
 ua:navigator.userAgent,language:navigator.language,languages:Array.from(navigator.languages),
 data:await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','wow64','fullVersionList']),
});
const touch=()=>{
 const queries=['(pointer: coarse)','(pointer:coarse)','(any-pointer: coarse)','(hover: none)','(any-hover:none)','(min-width: 1px) and (pointer: fine)'];
 return {
  maxTouchPoints:navigator.maxTouchPoints,touchEvent:'ontouchstart' in window,
  nativeGetter:String(Object.getOwnPropertyDescriptor(Navigator.prototype,'maxTouchPoints').get).includes('[native code]'),
  nativeMatchMedia:String(window.matchMedia).includes('[native code]'),
  js:queries.map(q=>matchMedia(q).matches),
  css:queries.map((_,i)=>getComputedStyle(document.getElementById('q'+i)).getPropertyValue('--hit').trim()==='1'),
 };
};
(async()=>{
 await app.whenReady();
 const requests=[];
 server=http.createServer((req,res)=>{
  requests.push(req.headers);
  res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':'text/html');
  if(req.url==='/dedicated.js')return res.end('onmessage=async()=>postMessage(await ('+probe.toString()+')())');
  if(req.url==='/shared.js')return res.end('onconnect=e=>{const p=e.ports[0];p.onmessage=async()=>p.postMessage(await ('+probe.toString()+')());p.start()}');
  if(req.url==='/service.js')return res.end('oninstall=()=>skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=async e=>e.ports[0].postMessage(await ('+probe.toString()+')())');
  if(req.url==='/cross-frame')return res.end('<script>('+probe.toString()+')().then(data=>parent.postMessage({kind:"identity-frame",data},"*")).catch(e=>parent.postMessage({kind:"identity-frame",data:{error:String(e)}},"*"))</script>');
  const queries=['(pointer: coarse)','(pointer:coarse)','(any-pointer: coarse)','(hover: none)','(any-hover:none)','(min-width: 1px) and (pointer: fine)'];
  const css=queries.map((q,i)=>'#q'+i+'{--hit:0}@media '+q+'{#q'+i+'{--hit:1}}').join('');
  res.end('<title>Identity test</title><script>window.initBeforeScripts=Notification.permission</script><style>'+css+'</style>'+queries.map((_,i)=>'<div id="q'+i+'">probe</div>').join(''));
 });
 await new Promise(r=>server.listen(0,'0.0.0.0',r));
 const base='http://127.0.0.1:'+server.address().port;
 host=new BrowserWindow({show:false});await host.loadURL('data:text/html,Host');
 baseline=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await baseline.loadURL(base+'/baseline');
 const nativeTouch=await baseline.webContents.executeJavaScript('('+touch.toString()+')()');
 const partition='identity-test-'+Date.now();
 const browser=new ChatterBrowser(host,{homeUrl:'about:blank',partition,backgroundSize:{width:800,height:600}});browsers.push(browser);
 await browser.control({action:'open',url:base+'/main'});
 const wc=browser.view.webContents;
 // This is an actual effect of the init script; the regression had native "denied".
 assert.equal(await wc.executeJavaScript('Notification.permission'),'default','init-script executes in the remote document');
 assert.equal(await wc.executeJavaScript('window.initBeforeScripts'),'default','init-script precedes the first page script');
 const webdriver=await wc.executeJavaScript('({value:navigator.webdriver,nativeGetter:String(Object.getOwnPropertyDescriptor(Navigator.prototype,"webdriver").get).includes("[native code]")})');
 const nativeWebdriver=await baseline.webContents.executeJavaScript('({value:navigator.webdriver,nativeGetter:String(Object.getOwnPropertyDescriptor(Navigator.prototype,"webdriver").get).includes("[native code]")})');
 assert.deepEqual(webdriver,nativeWebdriver,'webdriver preserves the native value and getter');
 assert.ok(webdriver.nativeGetter,'webdriver getter must not be replaced by JavaScript');
 const windowData=await wc.executeJavaScript('('+probe.toString()+')()');
 const workerData=await wc.executeJavaScript('('+async function(){
  const dedicated=await new Promise((resolve,reject)=>{const w=new Worker('/dedicated.js');w.onerror=e=>reject(Error(e.message));w.onmessage=e=>{w.terminate();resolve(e.data)};w.postMessage(1)});
  const shared=await new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js');w.onerror=e=>reject(Error(e.message));w.port.onmessage=e=>{w.port.close();resolve(e.data)};w.port.start();w.port.postMessage(1)});
  const registration=await navigator.serviceWorker.register('/service.js');
  await navigator.serviceWorker.ready;
  const service=await new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data)};registration.active.postMessage(1,[channel.port2])});
  return{dedicated,shared,service};
 }.toString()+')()');
 for(const [kind,data] of Object.entries(workerData))assert.deepEqual(data,windowData,kind+' identity matches the window (including high-entropy values and languages)');
 const frameData=await wc.executeJavaScript('('+async function(probeSource,crossUrl){
  const frame=document.createElement('iframe');
  frame.src='/frame';const loaded=new Promise(r=>frame.onload=r);document.body.append(frame);await loaded;
  const same=await frame.contentWindow.eval('('+probeSource+')()');
  const nested=frame.contentDocument.createElement('iframe');nested.src='/nested';
  const loadedNested=new Promise(r=>nested.onload=r);frame.contentDocument.body.append(nested);await loadedNested;
  const nestedData=await nested.contentWindow.eval('('+probeSource+')()');
  const cross=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('cross-frame response timeout')),5000);const onMessage=e=>{if(e.data?.kind==='identity-frame'){clearTimeout(timer);removeEventListener('message',onMessage);resolve(e.data.data)}};addEventListener('message',onMessage);const f=document.createElement('iframe');f.onerror=()=>reject(Error('cross-frame load error'));f.src=crossUrl;document.body.append(f)});
  return{same,nested:nestedData,cross};
 }.toString()+')('+JSON.stringify(probe.toString())+','+JSON.stringify('http://127.0.0.2:'+server.address().port+'/cross-frame')+')');
 for(const [kind,data] of Object.entries(frameData))assert.deepEqual(data,windowData,kind+' iframe identity matches');
 const actualTouch=await wc.executeJavaScript('('+touch.toString()+')()');
 assert.deepEqual(actualTouch,nativeTouch,'native touch capability is preserved');
 assert.deepEqual(actualTouch.js,actualTouch.css,'simple, compact and compound JS queries agree with real CSS');
 assert.ok(actualTouch.nativeGetter&&actualTouch.nativeMatchMedia,'touch getters and matchMedia remain native');
 await browser.control({action:'open',url:base+'/second'});
 assert.equal(await wc.executeJavaScript('Notification.permission'),'default','init-script survives navigation');
 // Sibling views share a session and must remain coherent after the first closes.
 const sibling=new ChatterBrowser(host,{homeUrl:'about:blank',partition,backgroundSize:{width:800,height:600}});browsers.push(sibling);
 browser.destroy();browsers.shift();
 await sibling.control({action:'open',url:base+'/sibling'});
 assert.deepEqual(await sibling.view.webContents.executeJavaScript('('+probe.toString()+')()'),windowData);
 assert.equal(await sibling.view.webContents.executeJavaScript('Notification.permission'),'default');
 for(const headers of requests)if(headers['user-agent'])assert.ok(!/Electron|chatter/i.test(headers['user-agent']),'app UA tokens are not sent');
 console.log('PASS: real init-script, Window/Dedicated/Shared/Service Worker and iframe identities, native CSS/touch, navigation and shared-session lifecycle');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 for(const browser of browsers)browser.destroy();
 baseline?.destroy();host?.destroy();
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
 app.exit(process.exitCode||0);
});
`);
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; process.stdout.write(data); }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron identity test timed out')); }, 45_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, output);
} finally {
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('chatter-identity-test-'));
  fs.rmSync(target, { recursive: true, force: true });
}
