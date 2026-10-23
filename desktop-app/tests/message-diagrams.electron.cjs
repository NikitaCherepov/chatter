// Run with Electron after `npm run build`. Uses fresh storage, hidden UI and no network.
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-diagram-test-')));
app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  host.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const dist = path.resolve(__dirname, '../dist/renderer');
  const worker = fs.readdirSync(path.join(dist, 'assets')).find(name => /^diagram-layout\.worker-.*\.js$/.test(name));
  assert.ok(worker, 'production worker must be packaged');
  await host.loadFile(path.join(dist, 'index.html'));
  const result = await host.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const worker = new Worker(${JSON.stringify(pathToFileURL(path.join(dist, 'assets', worker)).href)});
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('layout_timeout')); }, 10000);
    worker.onerror = error => { clearTimeout(timeout); worker.terminate(); reject(new Error(error.message)); };
    worker.onmessage = event => {
      if (event.data.error) { clearTimeout(timeout); worker.terminate(); reject(new Error(JSON.stringify(event.data.error))); return; }
      if (event.data.id === 0) worker.postMessage({ id: 1, cmd: 'layout', graph: {
        id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN' },
        children: [{ id: 'a', width: 120, height: 60 }, { id: 'b', width: 120, height: 60 }],
        edges: [{ id: 'e', sources: ['a'], targets: ['b'] }]
      }});
      else { clearTimeout(timeout); worker.terminate(); resolve(event.data.data); }
    };
    worker.postMessage({ id: 0, cmd: 'register', algorithms: ['layered'] });
  })`);
  assert.ok(result.width > 0 && result.height > 0);
  assert.ok(result.children[0].y < result.children[1].y);
  assert.ok(result.edges[0].sections.length);
  host.destroy();
  console.log('PASS: packaged ELK worker executes under Electron file://, sandbox and production CSP without network');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
