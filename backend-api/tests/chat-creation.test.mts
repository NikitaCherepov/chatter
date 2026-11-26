import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-create-chat-'));
process.env.API_DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOADS_DIR = path.join(directory, 'uploads');
const { db } = await import('../src/db.js');
const { createConfiguredChat, startPromptChat, parseChatCreationOptions } =
  await import('../src/services/chat-creation.js');
const {
  createUserPromptWithSelection,
  parseUserPromptRowId,
  updateUserPromptImage,
  deleteUserPrompt,
} = await import('../src/services/prompts.js');
const { getUserById, resolvePromptForChat, createUserChat } =
  await import('../src/services/chats.js');
const { createPersona, resolvePersonaForChat, updatePersonaImage } =
  await import('../src/services/memory-foundation.js');
const { saveImageAsset, attachMediaAsset } = await import('../src/services/media-assets.js');
const sharp = (await import('sharp')).default;
try {
  db.prepare(
    "INSERT INTO users(id,name,language,status) VALUES(201,'Owner','en','approved'),(202,'Other','en','approved')",
  ).run();
  const a = createUserPromptWithSelection(201, 'A', 'First', 'Character A');
  const b = createUserPromptWithSelection(201, 'B', 'Second', 'Character B', false);
  assert.equal(getUserById(201)!.selected_prompt_id, a, 'select:false never changes global prompt');
  const foreign = createUserPromptWithSelection(202, 'Foreign', '', 'Private', false);
  const persona = createPersona(201, 'Role $&', 'Biography', 'Memory'),
    otherPersona = createPersona(202, 'Private');
  const image = await saveImageAsset({
    userId: 201,
    data: await sharp({ create: { width: 4, height: 4, channels: 4, background: '#f0c000' } })
      .png()
      .toBuffer(),
    kind: 'prompt_avatar',
  });
  const rowId = parseUserPromptRowId(b)!;
  updateUserPromptImage(201, rowId, image.url);
  attachMediaAsset({
    assetId: image.id,
    entityType: 'user_prompt',
    entityId: rowId,
    slot: 'avatar',
  });
  updatePersonaImage(201, persona.id, image.url);
  attachMediaAsset({
    assetId: image.id,
    entityType: 'persona',
    entityId: persona.id,
    slot: 'avatar',
  });
  const previous = createUserChat(201, 'Existing');
  const empty = await createConfiguredChat(201, {
    promptId: b,
    personaId: persona.id,
    activate: false,
  });
  assert.equal(empty.messageId, null);
  assert.equal(resolvePromptForChat(getUserById(201)!, empty.chatId).id, b);
  assert.equal(resolvePersonaForChat(201, empty.chatId).persona.id, persona.id);
  assert.equal(
    (db.prepare('SELECT active_chat_id FROM users WHERE id=201').get() as any).active_chat_id,
    previous,
  );
  assert.equal(getUserById(201)!.selected_prompt_id, a);
  const started = await startPromptChat(201, b, {
    firstMessage: {
      content: 'I am {{char}}; hello {{user}}',
      images: [{ promptId: b }, { personaId: persona.id }],
    },
    personaId: persona.id,
  });
  const message = db
    .prepare('SELECT role,content,images,prompt_id FROM chat_messages WHERE id=?')
    .get(started.messageId) as any;
  assert.equal(message.role, 'assistant');
  assert.equal(message.content, 'I am B; hello Role $&');
  assert.equal(message.prompt_id, b);
  assert.equal(JSON.parse(message.images).length, 2);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id=? AND role='user'")
        .get(started.chatId) as any
    ).count,
    0,
  );
  assert.ok(
    db.prepare('SELECT 1 FROM chat_message_variants WHERE message_id=?').get(started.messageId),
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM media_asset_references WHERE asset_id=? AND entity_type='chat_message' AND entity_id=?",
      )
      .get(image.id, started.messageId),
  );
  const photo = await createConfiguredChat(201, {
    promptId: b,
    firstMessage: { images: [{ url: image.url }] },
  });
  assert.ok(photo.messageId, 'a photo-only opening is supported');
  const bare = await startPromptChat(201, b, { firstMessage: null });
  assert.equal(bare.messageId, null);
  const before = (
    db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id=201').get() as any
  ).count;
  const activeBefore = (db.prepare('SELECT active_chat_id FROM users WHERE id=201').get() as any)
    .active_chat_id;
  for (const options of [
    { promptId: foreign },
    { personaId: otherPersona.id },
    { firstMessage: { images: [{ promptId: foreign }] } },
    { firstMessage: { images: [{ personaId: otherPersona.id }] } },
  ])
    await assert.rejects(() => createConfiguredChat(201, options as any), /not_found/);
  await assert.rejects(
    () => createConfiguredChat(202, { firstMessage: { images: [{ url: image.url }] } }),
    /chat_image_unavailable/,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id=201').get() as any).count,
    before,
  );
  db.exec(
    "CREATE TRIGGER fail_opening BEFORE INSERT ON chat_messages WHEN NEW.content='fail-fixture' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  await assert.rejects(
    () => createConfiguredChat(201, { promptId: b, firstMessage: { content: 'fail-fixture' } }),
    /fixture/,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM user_chats WHERE user_id=201').get() as any).count,
    before,
    'failed opening removes the new chat',
  );
  assert.equal(
    (db.prepare('SELECT active_chat_id FROM users WHERE id=201').get() as any).active_chat_id,
    activeBefore,
    'failed creation restores the old active chat',
  );
  db.exec('DROP TRIGGER fail_opening');
  for (const input of [
    { prompt_id: 0 },
    { persona_id: -1 },
    { activate: 'no' },
    { first_message: { images: [{ url: 'https://example.com/x.png' }] } },
    { first_message: { images: [{ persona_id: persona.id, url: image.url }] } },
  ])
    assert.throws(() => parseChatCreationOptions(input), /bad_/);
  assert.equal(
    parseChatCreationOptions({ prompt_id: b, first_message: { images: [{ prompt_id: b }] } })
      .promptId,
    b,
  );
  deleteUserPrompt(201, rowId);
  assert.ok(
    fs.existsSync(path.join(process.env.UPLOADS_DIR!, image.storage_filename)),
    'message retains avatar media after deleting the source prompt',
  );
  console.log(
    'PASS: unselected prompt creation; per-chat prompt/persona binding; empty/text/photo openings; macros, variants and media ownership; global settings preserved; failed-create cleanup',
  );
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
