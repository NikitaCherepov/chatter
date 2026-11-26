const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { app, BrowserWindow, protocol, nativeImage } = require('electron');
const { InteractivePreviews } = require('../dist/main/interactive-preview.js');
const { INTERACTIVE_SCHEME } = require('../dist/main/interactive-document.js');
const { THEME_DND_EXAMPLES } = require('../dist/main/theme-dnd-documentation.js');
protocol.registerSchemesAsPrivileged([
  {
    scheme: INTERACTIVE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-effects-ui-'));
app.setPath('userData', temp);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Minimal textured triangle: exercise GLTFLoader's actual embedded-image paths.
const png = nativeImage
  .createFromBitmap(Buffer.from([0x22, 0xbb, 0x44, 0xff]), { width: 1, height: 1 })
  .toPNG();
function texturedGlb(image) {
  const geometry = Buffer.alloc(60);
  [-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 1].forEach((value, index) =>
    geometry.writeFloatLE(value, index * 4),
  );
  const embedded = image === 'embedded';
  const binary = Buffer.concat([geometry, ...(embedded ? [png] : [])]);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: [{ source: 0 }],
    images: [embedded ? { bufferView: 2, mimeType: 'image/png' } : { uri: image }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      ...(embedded ? [{ buffer: 0, byteOffset: 60, byteLength: png.length }] : []),
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-1, -1, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
  };
  const json = Buffer.from(JSON.stringify(gltf)),
    jsonLength = Math.ceil(json.length / 4) * 4,
    binaryLength = Math.ceil(binary.length / 4) * 4;
  const glb = Buffer.alloc(12 + 8 + jsonLength + 8 + binaryLength);
  glb.write('glTF');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  glb.fill(0x20, 20, 20 + jsonLength);
  json.copy(glb, 20);
  glb.writeUInt32LE(binaryLength, 20 + jsonLength);
  glb.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(glb, 28 + jsonLength);
  return glb;
}
async function until(check) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 15000) throw Error('Effects fixture timed out');
    await delay(40);
  }
}
let host, manager;
app
  .whenReady()
  .then(async () => {
    host = new BrowserWindow({
      show: false,
      opacity: 0,
      skipTaskbar: true,
      width: 900,
      height: 700,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    await host.loadURL('data:text/html,<main>Fixture host</main>');
    host.showInactive();
    let visible = true;
    host.isVisible = () => visible;
    host.isMinimized = () => false;
    const actions = [];
    let escapes = 0;
    const original = host.webContents.send.bind(host.webContents);
    host.webContents.send = (channel, payload) => {
      if (channel === 'interactive-preview:appearance-action') actions.push(payload.action);
      if (channel === 'interactive-preview:status' && payload.escape) escapes++;
      original(channel, payload);
    };
    let reads = 0;
    const models = {
      'assets/embedded.glb': texturedGlb('embedded'),
      'assets/data.glb': texturedGlb('data:image/png;base64,' + png.toString('base64')),
      'assets/relative.glb': texturedGlb('texture.png'),
      'assets/texture.png': png,
    };
    const modelAssets = Object.fromEntries(
      Object.keys(models).map((name, index) => [
        name,
        'chatter-theme://' +
          'a'.repeat(24) +
          '/' +
          String(index + 1).repeat(64) +
          path.extname(name),
      ]),
    );
    manager = new InteractivePreviews(undefined, (_owner, url) => {
      const model = Object.keys(modelAssets).find((name) => modelAssets[name] === url);
      if (model)
        return {
          data: models[model],
          mimeType: model.endsWith('.png') ? 'image/png' : 'model/gltf-binary',
        };
      assert.equal(url, 'chatter-theme://' + 'a'.repeat(24) + '/' + 'b'.repeat(64) + '.wav');
      reads++;
      return { data: Buffer.from('fixture-local-asset'), mimeType: 'audio/wav' };
    });
    const project = {
      entry: 'App.tsx',
      assets: {
        ...modelAssets,
        'assets/click.wav': 'chatter-theme://' + 'a'.repeat(24) + '/' + 'b'.repeat(64) + '.wav',
      },
      files: {
        'SortableList.tsx': THEME_DND_EXAMPLES['SortableList.tsx'],
        'dnd.css':
          '#dnd-test li{height:44px;list-style:none}#dnd-test ul{padding:0;margin:0}#dnd-test button{width:36px;height:36px}',
        'App.tsx': `
import React from 'react';
import {Canvas,useFrame} from '@react-three/fiber';
import {Float,useGLTF} from '@react-three/drei';
import {Vector3} from 'three';
import {motion} from 'framer-motion';
import {gsap} from 'gsap';
import {useThemeEffects,useThemeAudio,assetSource} from '@chatter/ui';
import {SortableList} from './SortableList';
import './dnd.css';
function Mesh(){useFrame(()=>{window.meshFrames=(window.meshFrames||0)+1;});return <Float><mesh><boxGeometry/><meshBasicMaterial color="#00eebb"/></mesh></Float>}
function Model({name}){const model=useGLTF(assetSource('assets/'+name+'.glb'),false,false);
  React.useEffect(()=>{const mesh=model.scene.children[0],image=mesh.material.map?.image;window.texturedModels={...window.texturedModels,[name]:{width:image?.width,height:image?.height}};},[model]);
  return <primitive object={model.scene}/>;}
export default function App(){const effects=useThemeEffects(),audio=useThemeAudio();
  const [items,setItems]=React.useState([{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'},{id:'gamma',label:'Gamma'}]);
  React.useEffect(()=>{window.libraryCheck={vector:new Vector3(1,2,3).length(),gsap:gsap.version};
    const frame=()=>{window.frameCount=(window.frameCount||0)+1;requestAnimationFrame(frame);};const id=requestAnimationFrame(frame);
    fetch(assetSource('assets/click.wav')).then(r=>r.text()).then(text=>window.assetText=text).catch(e=>window.assetError=String(e));
    window.musicAutoplay=audio.music.play('assets/click.wav');
    return()=>cancelAnimationFrame(id);
  },[]);
  return <motion.main id="ready" initial={{opacity:0}} animate={{opacity:1}}>
    <output id="active">{String(effects.active)}</output>
    <button id="sound" onClick={()=>{audio.setPreferences({soundEnabled:true});audio.tone(440,80,.2)}}>Sound</button>
    <button id="music" onClick={()=>{audio.setPreferences({musicEnabled:true});audio.music.play('assets/click.wav')}}>Music</button>
    <div style={{width:300,height:200}}><Canvas onCreated={({gl})=>window.glReady=!!gl.getContext()}><Mesh/></Canvas></div>
    <div style={{width:80,height:80}}><Canvas><React.Suspense fallback={null}>{['embedded','data','relative'].map(name=><Model key={name} name={name}/>)}</React.Suspense></Canvas></div>
    <section id="dnd-test"><SortableList items={items} onReorder={setItems} handleLabel={item=>'Move '+item.label}/><output id="order">{items.map(item=>item.id).join(',')}</output></section>
  </motion.main>;
}`,
      },
    };
    const id = manager.create(host.webContents, {
      language: 'tsx',
      source: '',
      dark: true,
      errorLabel: 'Fixture error',
      project,
      bridge: 'appearance-chat-list-v1',
    });
    manager.place(host.webContents, {
      id,
      bounds: { x: 0, y: 0, width: 850, height: 620 },
      clip: { x: 0, y: 0, width: 850, height: 620 },
      visible: true,
    });
    const view = manager.entries.get(id).view.webContents;
    view.setBackgroundThrottling(false);
    const errors = [];
    view.on('console-message', (_event, level, message) => {
      if (level >= 2) errors.push(message);
    });
    const state = {
      scopeId: 'effects-fixture',
      chats: [],
      sections: [],
      messages: [],
      view: 'home',
      activeChatId: null,
      themeEffects: {
        effectsEnabled: true,
        intensity: 1,
        soundEnabled: false,
        musicEnabled: false,
        soundVolume: 0.3,
        musicVolume: 0.2,
      },
      themeAudio: { music: { asset: null, status: 'idle' }, activeSounds: 0, error: null },
    };
    manager.updateAppearanceState(host.webContents, id, state);
    const js = (code) => view.executeJavaScript(code);
    try {
      await until(() => js('!!document.querySelector("#ready")'));
      await until(() =>
        js('window.assetText==="fixture-local-asset" && window.glReady && window.meshFrames>1'),
      );
      assert.equal(reads, 1);
      await until(() => js('Object.keys(window.texturedModels||{}).length===3'));
      assert.deepEqual(await js('window.texturedModels'), {
        embedded: { width: 1, height: 1 },
        data: { width: 1, height: 1 },
        relative: { width: 1, height: 1 },
      });
      console.log(
        'PASS: GLB embedded blob, inline data URI and relative local texture load through real Drei/GLTFLoader without extraction',
      );
      assert.equal(await js('window.musicAutoplay'), false);
      assert.ok((await js('window.libraryCheck.vector')) > 3);
      assert.equal(await js('window.libraryCheck.gsap'), '3.15.1');
      assert.equal(view.isAudioMuted(), true);
      assert.equal(await js('chatter.assetSource("assets/missing.wav")'), '');
      assert.equal(await js('fetch("https://example.com").then(()=>true,()=>false)'), false);
      const click = async (selector) => {
        const rect = await js(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
        );
        view.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect });
        view.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect });
        await delay(80);
      };
      await click('#sound');
      await click('#music');
      assert.ok(actions.some((a) => a.type === 'themePreferences' && a.patch.soundEnabled));
      assert.ok(actions.some((a) => a.type === 'themeAudio' && a.action === 'tone'));
      assert.ok(actions.some((a) => a.type === 'themeAudio' && a.action === 'musicPlay'));
      const key = async (keyCode) => {
        view.sendInputEvent({ type: 'keyDown', keyCode });
        view.sendInputEvent({ type: 'keyUp', keyCode });
        await delay(120);
      };
      await js('document.querySelector("[data-drag-handle=alpha]").focus()');
      await key('Space');
      await key('Down');
      await key('Space');
      await until(() => js('document.querySelector("#order").textContent==="beta,alpha,gamma"'));
      const bounds = (selector) =>
        js(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
        );
      const start = await bounds('[data-drag-handle=gamma]'),
        target = await bounds('[data-drag-handle=beta]');
      view.sendInputEvent({ type: 'mouseMove', ...start });
      view.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
      view.sendInputEvent({ type: 'mouseMove', x: start.x, y: start.y - 10 });
      await delay(80);
      view.sendInputEvent({ type: 'mouseMove', ...target });
      await delay(120);
      view.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
      await until(() => js('document.querySelector("#order").textContent==="gamma,beta,alpha"'));
      await js('document.querySelector("[data-drag-handle=gamma]").focus()');
      await key('Space');
      await key('Down');
      await key('Escape');
      await delay(80);
      assert.equal(await js('document.querySelector("#order").textContent'), 'gamma,beta,alpha');
      assert.equal(escapes, 0, 'drag cancellation does not close the theme');
      console.log(
        'PASS: all four bundled dnd-kit packages share context; real pointer/keyboard sorting and Escape cancellation use the documented reusable example',
      );
      visible = false;
      host.emit('hide');
      await until(() => js('document.querySelector("#active").textContent==="false"'));
      await delay(100);
      const count = await js('window.frameCount');
      await delay(250);
      assert.equal(await js('window.frameCount'), count, 'hidden animation frames paused');
      assert.equal(await js('document.documentElement.hasAttribute("data-theme-paused")'), true);
      visible = true;
      host.emit('show');
      await until(() => js(`window.frameCount>${count}`));
      manager.updateAppearanceState(host.webContents, id, {
        ...state,
        themeEffects: { ...state.themeEffects, effectsEnabled: false },
      });
      await until(() => js('document.documentElement.hasAttribute("data-theme-reduced")'));
      console.log(
        'PASS: real isolated Three/Fiber/Drei Canvas, Motion and GSAP with shared React; local asset fetch; gesture-only music/preferences; blocked external network, muted raw audio and animation hide/resume',
      );
    } catch (error) {
      console.error(
        'Renderer diagnostics:',
        errors,
        await js(
          '({html:document.body.innerHTML.slice(0,3000),gl:window.glReady,frames:window.frameCount,mesh:window.meshFrames,asset:window.assetText,assetError:window.assetError,library:window.libraryCheck,env:chatter.getThemeEnvironment()})',
        ).catch(() => null),
      );
      throw error;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    manager?.destroy();
    host?.destroy();
    app.exit(process.exitCode ?? 0);
  });
