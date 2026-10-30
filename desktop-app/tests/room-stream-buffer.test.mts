import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RoomStreamBuffer } = require('../src/renderer/lib/room-stream-buffer.ts');
const { ChatStreamBuffer } = require('../../backend-api/src/services/chat-stream-buffer.ts');
const start = {
  type: 'chat_agent_start',
  chat_id: 12,
  agent_id: null,
  prompt_name: 'Assistant',
  regenerate_message_id: 45,
};
const server = new ChatStreamBuffer(start);
const initial = server.snapshot();
const first = server.event({ type: 'chat_agent_token', text: 'Hello' });
const reasoning = server.event({ type: 'chat_agent_reasoning', text: 'Think' });
const snap = server.snapshot();
const last = server.event({ type: 'chat_agent_token', text: ' world' });
const client = new RoomStreamBuffer(initial.stream_id);
client.restore(initial);
client.push(first);
client.push(reasoning);
assert.equal(client.read().content, 'Hello');
// Token arrives while the HTTP snapshot is in flight.
client.push(last);
client.restore(snap);
client.push(last);
assert.equal(client.read().content, 'Hello world');
assert.equal(client.read().reasoning_content, 'Think');
assert.equal(client.read().regenerate_message_id, 45);
// Joined after start: queue later tokens and replay only those absent from status.
const late = new RoomStreamBuffer(initial.stream_id);
late.push(last);
late.push(first);
late.restore(snap);
assert.equal(late.read().content, 'Hello world');
// Out-of-order and repeated delivery, including a reasoning gap.
const outOfOrder = new RoomStreamBuffer(initial.stream_id);
outOfOrder.restore(initial);
outOfOrder.push(last);
outOfOrder.push(first);
assert.equal(outOfOrder.read().content, 'Hello');
outOfOrder.push(reasoning);
outOfOrder.push(last);
assert.equal(outOfOrder.read().content, 'Hello world');
outOfOrder.restore(initial);
assert.equal(outOfOrder.read().sequence, 3);
const tool = server.event({ type: 'chat_tool_status', text: 'Reading' });
const intermediate = server.event({ type: 'chat_intermediate', text: 'Read result' });
client.push(tool);
assert.equal(client.read().tool_status, 'Reading');
assert.equal(client.read().content, 'Hello world', 'current activity must not become answer text');
assert.equal(server.snapshot().content, 'Hello world\n\nRead result');
const waiting = new RoomStreamBuffer(initial.stream_id);
waiting.restore({ ...client.read() });
assert.equal(waiting.read().tool_status, 'Reading', 'activity survives a stream snapshot');
client.push(intermediate);
assert.equal(client.read().tool_status, null);
assert.equal(client.read().content, 'Hello world\n\nRead result');
const other = new ChatStreamBuffer({ ...start, chat_id: 13 });
assert.notEqual(other.snapshot().stream_id, initial.stream_id);
client.push(other.event({ type: 'chat_agent_token', text: 'Foreign' }));
client.restore(other.snapshot());
assert.equal(client.read().content, server.snapshot().content);
assert.equal(snap.content, 'Hello', 'snapshots must not mutate after new tokens');
assert.equal(server.event({ type: 'chat_agent_done' }).stream_id, initial.stream_id);
// A completed tool-call preface confirms token text; it is not a new paragraph.
const commitServer = new ChatStreamBuffer(start);
const commitClient = new RoomStreamBuffer(commitServer.snapshot().stream_id);
commitClient.restore(commitServer.snapshot());
const send = (event:any) => commitClient.push(commitServer.event(event));
send({type:'chat_agent_token', text:'Before '});
send({type:'chat_agent_token', text:'the tool.'});
send({type:'chat_intermediate', text:'Before the tool.', content:'Before the tool.'});
assert.equal(commitServer.snapshot().content,'Before the tool.');
assert.equal(commitClient.read().content,'Before the tool.');
assert.deepEqual(commitClient.read().intermediate_messages,['Before the tool.']);
send({type:'chat_tool_status', text:'Working'});
send({type:'chat_agent_token', text:'\n\nAfter the tool.'});
send({type:'chat_intermediate', text:'After the tool.', content:'Before the tool.\n\nAfter the tool.'});
assert.equal(commitClient.read().content,'Before the tool.\n\nAfter the tool.');
// Real repeated wording in another step must remain: no substring deduplication.
send({type:'chat_intermediate', text:'After the tool.', content:'Before the tool.\n\nAfter the tool.\n\nAfter the tool.'});
assert.equal(commitClient.read().content,commitServer.snapshot().content);
assert.equal(commitClient.read().content.split('After the tool.').length,3);
// A non-streaming step is still delivered, and late joins see the canonical text.
send({type:'chat_intermediate',text:'Non-streamed',content:'Canonical non-streamed answer'});
const commitLate = new RoomStreamBuffer(commitServer.snapshot().stream_id);
commitLate.restore(commitServer.snapshot());
assert.equal(commitLate.read().content,'Canonical non-streamed answer');
assert.deepEqual(commitLate.read().intermediate_messages,commitClient.read().intermediate_messages);
assert.deepEqual(commitLate.read().work_log,commitClient.read().work_log);
assert.equal(commitClient.read().work_log[0].type,'message');
assert.equal(commitClient.read().work_log[1].type,'activity');
assert.deepEqual(initial.intermediate_messages,[], 'old snapshots must remain immutable');
const liveServer = new ChatStreamBuffer(start);
const liveClient = new RoomStreamBuffer(liveServer.snapshot().stream_id);
liveClient.restore(liveServer.snapshot());
const pendingCall = {id:'live-1',name:'search_web',arguments:{query:'Tomsk'},running:true};
const startedCall = liveServer.event({type:'chat_tool_status',text:'',call:pendingCall});
liveClient.push(startedCall);
const pendingSnapshot = liveServer.snapshot();
assert.equal(liveClient.read().work_log[0].call.running,true);
const finishedCall = liveServer.event({type:'chat_tool_status',text:'',call:{...pendingCall,running:false,result_preview:'Results'}});
liveClient.push(finishedCall);liveClient.push(finishedCall);
assert.equal(liveClient.read().work_log.length,1,'completion updates the original tool row');
assert.equal(liveClient.read().work_log[0].call.result_preview,'Results');
assert.equal(pendingSnapshot.work_log[0].call.running,true,'completion cannot mutate older snapshots');
assert.deepEqual(liveClient.read().work_log,liveServer.snapshot().work_log);
const pendingLate = new RoomStreamBuffer(liveServer.snapshot().stream_id);
pendingLate.restore(pendingSnapshot);pendingLate.push(finishedCall);
assert.equal(pendingLate.read().work_log[0].call.running,false);
console.log(
  'PASS: background accumulation, late join, HTTP/event races, duplicate/out-of-order tokens, reasoning, tools, regeneration and chat isolation',
);
