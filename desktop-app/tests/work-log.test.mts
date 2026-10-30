import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { splitWorkContent } = require('../src/renderer/lib/work-log-content.ts');
const { getIntermediateMessages } = require('../../backend-api/src/services/intermediate-messages.ts');
const steps = [
  {step:1,content:'I will search.',tool_calls:[{name:'search_web'}]},
  {step:2,content:'Saving the result.',tool_calls:[{name:'save_note'}]},
  {step:3,content:'Here is the answer.',tool_calls:[],is_final:true},
];
const messages = getIntermediateMessages(steps);
assert.deepEqual(messages,['I will search.','Saving the result.']);
assert.deepEqual(getIntermediateMessages([{name:'legacy_tool'}]),[]);
assert.deepEqual(getIntermediateMessages(null),[]);
const full = 'I will search.\n\nSaving the result.\n\nHere is the answer.';
assert.deepEqual(splitWorkContent(full,messages),{answer:'Here is the answer.',messages});
assert.equal(splitWorkContent('I will search.',['I will search.']).answer,'');
assert.equal(splitWorkContent('Edited text',messages).answer,'Edited text');
assert.deepEqual(splitWorkContent('Edited text',messages).messages,[]);
assert.equal(splitWorkContent('First\n\nFirst\n\nLast',['First','First']).answer,'Last');
assert.equal(splitWorkContent('First\n',['First']).answer,'');
assert.equal(splitWorkContent('First thing',['First']).answer,'First thing','never strip a partial word');
assert.equal(splitWorkContent(full,undefined).answer,full,'legacy responses stay fully readable');
console.log('PASS: work-log trace extraction, exact separation, edited/legacy content, repeated steps and partial streaming separators');
