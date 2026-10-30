import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { describeToolCall, groupToolActivities } = require('../src/renderer/lib/tool-activity.ts');
const note = describeToolCall({ name: 'save_note', arguments: '{"title":"Weekend"}', result_preview: 'Note saved: #12' });
assert.equal(note.confirmed, true);
assert.equal(note.target, 'Weekend');
assert.equal(describeToolCall({name:'save_note',arguments:{},result_preview:'Pending approval'}).confirmed,false);
assert.equal(describeToolCall({name:'custom_tool',arguments:'bad json'}).status,'unknown');
for (const result of ['Tool error x: failed','Error: bad title','{"ok":false}', '{"error":"denied"}', '{"success":false,"data":', 'Tool "x" is disabled by current restriction settings.']) {
  assert.equal(describeToolCall({ name:'custom_tool', arguments:{}, result_preview:result }).status,'error',result);
}
for (const result of ['{"error":null}', '{"error":false}', '{"error":""}', 'Article discusses error handling.']) {
  assert.equal(describeToolCall({ name:'web_reader', arguments:{}, result_preview:result }).status,'returned',result);
}
const calls = Array.from({length:7},(_,i)=>({name:'web_search',arguments:{query:String(i)},result_preview:'Results'}));
calls.push({name:'set_display_state',arguments:{},result_preview:'Done'} as any);
calls.push({name:'set_display_state',arguments:{},result_preview:'Error: not supported'} as any);
const groups = groupToolActivities(calls);
assert.equal(groups.visible.length,4,'three ordinary results plus every error');
assert.equal(groups.visible.at(-1).status,'error','an internal error is never hidden');
assert.equal(groups.more.length,4);
assert.equal(groups.internal.length,1);
console.log('PASS: tool labels, explicit confirmation, malformed arguments, truncated errors, overflow and internal calls');
