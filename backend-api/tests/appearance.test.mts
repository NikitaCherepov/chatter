import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-appearance-'));
process.env.API_DB_PATH = path.join(temp, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(temp, 'images');
const { db } = await import('../src/db.js');
const schema = await import('../src/services/appearance-schema.js');
const { getAppearance, changeAppearance, appearanceFromJson } =
  await import('../src/services/appearance.js');
const { getChatLayouts, changeChatLayouts } = await import('../src/services/chat-layout.js');
const layoutSchema = await import('../src/services/chat-layout-schema.js');
const media = await import('../src/services/media-assets.js');
try {
  for (const id of [101, 202])
    db.prepare('INSERT INTO users (id,name,ui_settings) VALUES (?,?,?)').run(
      id,
      String(id),
      JSON.stringify({ show_tokens: false, browser_confirm_open: true }),
    );
  const p = schema.newAppearance('evening');
  assert.deepEqual(schema.parseAppearanceProfile(p), p, 'legacy profiles retain their data');
  const extended = {
    ...p,
    light: { ...p.light, surface: '#112233', chat: '#223344' },
    materials: {
      composer: {
        opacity: 0.75,
        blur: 16,
        shadow: 'soft' as const,
        border: 'defined' as const,
        radius: 12,
      },
    },
  };
  assert.equal(schema.parseAppearanceProfile(extended).light.surface, '#112233');
  assert.throws(
    () => schema.parseAppearanceProfile({ ...p, light: { ...p.light, surface: null } }),
    /appearance_invalid/,
  );
  assert.throws(
    () => schema.parseAppearanceProfile({ ...p, dark: { ...p.dark, chat: 'red' } }),
    /appearance_invalid/,
  );

  assert.throws(
    () => changeAppearance(101, { action: 'save', profile: p, apply: 'false' }),
    /appearance_invalid/,
  );
  assert.throws(() => schema.parseAppearanceProfile({ ...p, revision: 1.5 }), /appearance_invalid/);
  const original = getAppearance(101);
  const saved = changeAppearance(101, { action: 'save', profile: extended, apply: false });
  assert.equal(getAppearance(101).profiles[0].light.chat, '#223344');
  assert.equal(saved.profiles[0].light.surface, '#112233');
  assert.equal(saved.profiles[0].materials?.composer?.blur, 16);
  assert.equal(saved.profiles[0].materials?.composer?.opacity, 0.75);
  assert.equal(saved.activeId, null);
  assert.equal(saved.profiles[0].revision, 1);
  assert.equal(getAppearance(202).profiles.length, 0);
  const active = changeAppearance(101, { action: 'activate', id: p.id, revision: saved.revision });
  assert.equal(active.activeId, p.id);
  assert.throws(
    () => changeAppearance(101, { action: 'save', profile: { ...p, name: 'stale' }, apply: true }),
    /appearance_conflict/,
  );
  assert.throws(
    () => changeAppearance(101, { action: 'save', profile: active.profiles[0], apply: false }),
    /appearance_active_requires_apply/,
  );
  assert.equal(getAppearance(101).profiles[0].name, p.name);
  const applied = changeAppearance(101, {
    action: 'save',
    profile: { ...active.profiles[0], name: 'Updated' },
    apply: true,
  });
  assert.equal(applied.profiles[0].revision, 2);
  assert.throws(
    () => changeAppearance(101, { action: 'delete', id: p.id, revision: saved.revision }),
    /appearance_conflict/,
  );
  const stored = JSON.parse(
    (db.prepare('SELECT ui_settings FROM users WHERE id=101').get() as any).ui_settings,
  );
  assert.equal(stored.show_tokens, false);
  assert.equal(stored.browser_confirm_open, true);
  for (const invalid of [
    { ...p, css: 'body{display:none}' },
    { ...p, typography: { ...p.typography, uiFont: 'Inter; color:red' } },
    { ...p, geometry: { ...p.geometry, density: 0 } },
    { ...p, background: { ...p.background, image: 'javascript:alert(1)' } },
    { ...p, background: { ...p.background, image: 'file:///secret' } },
    { ...p, background: { ...p.background, image: 'https://user:pass@example.com/a.png' } },
    { ...p, motion: { ...p.motion, duration: 999999 } },
    { ...p, light: { ...p.light, background: 'var(--anything)' } },
  ])
    assert.throws(() => schema.parseAppearanceProfile(invalid), /appearance_invalid/);
  assert.throws(
    () => schema.parseAppearanceSettings({ ...original, profiles: [p, p] }),
    /appearance_invalid/,
  );
  assert.deepEqual(appearanceFromJson('bad JSON'), original);
  // Image lifetime follows profile references, including duplicate variants and account isolation.
  const sharp = (await import('sharp')).default;
  for (const invalid of [
    null,
    { composer: null },
    { unknown: {} },
    { composer: { opacity: 0.2, blur: 16, shadow: 'soft', border: 'subtle' } },
    { composer: { opacity: 0.8, blur: 100, shadow: 'soft', border: 'subtle' } },
    { panels: { opacity: 0.8, blur: 16, shadow: 'url(x)', border: 'subtle' } },
    { panels: { opacity: 0.8, blur: 16, shadow: 'soft', border: 'subtle', css: 'color:red' } },
  ])
    assert.throws(
      () => schema.parseAppearanceProfile({ ...p, materials: invalid }),
      /appearance_invalid/,
    );
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer();
  const asset = await media.saveImageAsset({
    userId: 101,
    data: png,
    retention: 'temporary',
    kind: 'appearance_background',
  });
  const imageProfile = {
    ...schema.newAppearance('image'),
    background: { ...p.background, type: 'image', image: asset.url },
  };
  const withImage = changeAppearance(101, { action: 'save', profile: imageProfile, apply: false });
  assert.equal(media.getMediaAssetByUrl(asset.url)?.retention, 'persistent');
  assert.throws(
    () => changeAppearance(202, { action: 'save', profile: imageProfile, apply: true }),
    /appearance_image_not_found/,
  );
  assert.equal(getAppearance(202).profiles.length, 0);
  const withCopy = changeAppearance(101, {
    action: 'save',
    profile: { ...imageProfile, id: 'image-copy' },
    apply: false,
  });
  const removed = changeAppearance(101, {
    action: 'delete',
    id: 'image',
    revision: withCopy.revision,
  });
  assert.ok(media.getMediaAssetByUrl(asset.url));
  changeAppearance(101, { action: 'delete', id: 'image-copy', revision: removed.revision });
  assert.equal(media.getMediaAssetByUrl(asset.url), null);
  // Exercise the actual settings handlers: unrelated settings must preserve appearances.
  const require = createRequire(import.meta.url),
    ts = require('typescript');
  const source = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const routes = new Map<string, string>();
  function visit(node: any) {
    if (
      ts.isCallExpression(node) &&
      ['app.get', 'app.put', 'app.post'].includes(node.expression.getText(ast)) &&
      ts.isStringLiteral(node.arguments[0])
    )
      routes.set(
        node.expression.getText(ast) + ' ' + node.arguments[0].text,
        node.arguments[1].getText(ast),
      );
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const settingsCode = source.slice(
    source.indexOf('const VALID_UI_KEYS'),
    source.indexOf("app.get('/api/v1/user/ui-settings'"),
  );
  const context: any = {
    db,
    parseAppearanceSettings: schema.parseAppearanceSettings,
    appearanceFromJson,
    getAppearance,
    changeAppearance,
    getChatLayouts,
    changeChatLayouts,
    parseChatLayoutSettings: layoutSchema.parseChatLayoutSettings,
    saveImageAsset: media.saveImageAsset,
    accountIdFromRequest: (req: any) => req.userId,
    getUserById: (id: number) => db.prepare('SELECT * FROM users WHERE id=?').get(id),
    Buffer,
  };
  vm.createContext(context);
  vm.runInContext(
    ts.transpileModule(settingsCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText,
    context,
  );
  async function request(method: string, url: string, body: any, userId = 101) {
    let status = 200,
      result: any;
    vm.runInContext(
      ts.transpileModule('globalThis.handler=' + routes.get('app.' + method + ' ' + url), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
    await context.handler(
      { userId, body },
      {
        status(n: number) {
          status = n;
          return this;
        },
        json(value: any) {
          result = value;
          return this;
        },
      },
    );
    return { status, result };
  }
  const before = getAppearance(101);
  const layoutUrl = '/api/v1/user/chat-layout';
  const profile = { ...layoutSchema.CHAT_LAYOUT_CAPABILITIES.template, id: 'reading', chatSide: 'right', sidebarWidth: 290 };
  const saveLayout = (profile: unknown, apply: boolean) => request('post', layoutUrl, { action: 'save', profile, apply });
  assert.equal((await request('get', layoutUrl, {})).result.layout.activeId, null);
  assert.equal((await saveLayout({ ...profile, sidebarWidth: 800 }, true)).status, 400);
  assert.equal((await saveLayout({ ...profile, chatSide: 'top' }, true)).status, 400);
  assert.equal((await saveLayout(profile, false)).result.layout.activeId, null);
  assert.equal((await saveLayout(profile, true)).status, 409, 'a stale draft cannot replace a saved layout');
  assert.equal((await saveLayout({ ...profile, revision: 1 }, true)).result.layout.activeId, 'reading');
  const activeLayout = getChatLayouts(101);
  assert.equal((await saveLayout({ ...profile, revision: 2 }, false)).status, 400, 'saving an active edit requires explicit apply');
  assert.equal((await request('get', layoutUrl, {}, 202)).result.layout.profiles.length, 0);
  const toggled = await request('put', '/api/v1/user/ui-settings', {
    settings: { dice_roll_enabled: true, appearance: {}, chat_layout: { activeId: null, revision: 0, profiles: [] } },
  });
  assert.equal(toggled.status, 200);
  assert.deepEqual(getAppearance(101), before);
  assert.deepEqual(getChatLayouts(101), activeLayout, 'generic UI updates preserve the active layout');
  assert.ok((await request('get', '/api/v1/user/ui-settings', {})).result.settings.appearance);
  const conflict = await request('post', '/api/v1/user/appearance', {
    action: 'activate',
    id: null,
    revision: 0,
  });
  assert.equal(conflict.status, 409);
  const image = await request('post', '/api/v1/user/appearance/image', {
    base64: png.toString('base64'),
  });
  assert.equal(image.status, 200);
  assert.ok(image.result.image.startsWith('/api/v1/images/'));
  assert.equal(
    (await request('post', '/api/v1/user/appearance/image', { base64: '' })).status,
    400,
  );
  // Actual bot builders/handlers: proposals never write the user settings.
  const ai = fs.readFileSync(new URL('../src/services/ai.ts', import.meta.url), 'utf8');
  const builder = ai.slice(
    ai.indexOf('const buildChatLayoutTools'),
    ai.indexOf('/** Build suggest_macro'),
  );
  const handlers = ai.slice(
    ai.indexOf("  if (toolName === 'get_chat_layout')"),
    ai.indexOf("  if (toolName === 'suggest_macro')"),
  );
  context.CHAT_LAYOUT_CAPABILITIES = layoutSchema.CHAT_LAYOUT_CAPABILITIES;
  context.parseChatLayoutProfile = layoutSchema.parseChatLayoutProfile;
  context.subagentExtra = { onDesktopAction: () => undefined };
  context.APPEARANCE_CAPABILITIES = schema.APPEARANCE_CAPABILITIES;
  context.parseAppearanceProfile = schema.parseAppearanceProfile;
  context.user = { id: 101 };
  context.randomUUID = () => 'proposal-test';
  context.desktopActionSink = { value: null };
  context.sendToDesktop = () => true;
  vm.runInContext(
    ts.transpileModule(
      builder +
        '\nglobalThis.definitions=buildAppearanceTools();\nglobalThis.layoutDefinitions=buildChatLayoutTools();\nglobalThis.tool=(toolName,parsed)=>{' +
        handlers +
        '};',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  assert.equal(context.definitions.length, 2);
  const proposed = JSON.parse(
    context.tool('suggest_appearance', { profile: schema.newAppearance('bot-theme') }),
  );
  assert.equal(proposed.status, 'proposed');
  assert.equal(context.desktopActionSink.value.action, 'suggest_appearance');
  assert.deepEqual(getAppearance(101), before);
  context.desktopActionSink = null;
  context.sendToDesktop = () => false;
  assert.equal(
    JSON.parse(context.tool('suggest_appearance', { profile: schema.newAppearance('offline') }))
      .error,
    'desktop_offline',
  );
  const caps = JSON.parse(context.tool('get_appearance', { view: 'capabilities' }));
  assert.ok(caps.template);
  assert.equal(caps.limits.profiles, 32);
  for (const motion of Object.values(caps.motion.presets)) {
    assert.deepEqual(
      schema.parseAppearanceProfile({ ...schema.newAppearance(), motion }).motion,
      motion,
    );
  }
  const motionProposal = {
    ...schema.newAppearance('bot-motion'),
    motion: caps.motion.presets.scale,
  };
  context.desktopActionSink = { value: null };
  assert.equal(
    JSON.parse(context.tool('suggest_appearance', { profile: motionProposal })).status,
    'proposed',
  );
  assert.equal(context.desktopActionSink.value.value.profile.motion.scale, 0.97);
  assert.equal(context.layoutDefinitions.length, 2);
  assert.equal(JSON.parse(context.tool('get_chat_layout', {})).active.sidebarWidth, 290);
  assert.equal(JSON.parse(context.tool('suggest_chat_layout', { profile })).error, 'chat_layout_conflict');
  assert.equal(JSON.parse(context.tool('suggest_chat_layout', { profile: { ...profile, id: 'bot-layout' } })).status, 'proposed');
  assert.equal(context.desktopActionSink.value.action, 'suggest_chat_layout');
  assert.deepEqual(getChatLayouts(101), activeLayout, 'a bot proposal must never save or apply');
  context.subagentExtra = undefined;
  assert.equal(JSON.parse(context.tool('suggest_chat_layout', { profile: { ...profile, id: 'bot-layout' } })).error, 'desktop_offline');
  const remove = await request('post', layoutUrl, { action: 'delete', id: 'reading', revision: activeLayout.revision });
  assert.equal(remove.result.layout.activeId, null);
  assert.equal(remove.result.layout.profiles.length, 0);

  console.log(
    'PASS: strict appearance contract, atomic revision conflicts, inactive saves, explicit application, account isolation, media lifetime, UI settings preservation, real HTTP handlers and read-only bot proposals, independent layout profiles and approval',
  );
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('chatter-appearance-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
