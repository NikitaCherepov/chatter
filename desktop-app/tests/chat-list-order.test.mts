import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { promoteChatInFolder } = createRequire(import.meta.url)('../src/renderer/lib/chat-list-order.ts');

const chats = [
  { id: 1, folder_id: null, title: 'First unfiled' },
  { id: 2, folder_id: 10, title: 'First in folder' },
  { id: 3, folder_id: null, title: 'Older unfiled' },
  { id: 4, folder_id: 20, title: 'Other folder' },
  { id: 5, folder_id: 10, title: 'Older in folder' },
];
const ids = (items: typeof chats) => items.map(chat => chat.id);
assert.equal(promoteChatInFolder(chats, 1), chats);
assert.equal(promoteChatInFolder(chats, 2), chats, 'first in its folder is a no-op even when not first globally');
assert.equal(promoteChatInFolder(chats, 999), chats, 'unknown/filtered chats must not be fabricated');
assert.equal(promoteChatInFolder([], 1).length, 0);
const unfiled = promoteChatInFolder(chats, 3);
assert.deepEqual(ids(unfiled), [3, 1, 2, 4, 5]);
assert.deepEqual(ids(unfiled.filter(chat => chat.folder_id !== null)), [2, 4, 5]);
const folder = promoteChatInFolder(chats, 5);
assert.deepEqual(ids(folder.filter(chat => chat.folder_id === 10)), [5, 2]);
assert.deepEqual(ids(folder.filter(chat => chat.folder_id !== 10)), [1, 3, 4]);
assert.equal(promoteChatInFolder(folder, 5), folder, 'repeated WS events do not reorder twice');
assert.equal(folder.find(chat => chat.id === 5), chats[4], 'preserve chat metadata and object identity');
assert.deepEqual(ids(chats), [1, 2, 3, 4, 5], 'never mutate the original state');
assert.equal(new Set(ids(folder)).size, chats.length, 'no duplicates');
console.log('chat-list-order tests passed');
