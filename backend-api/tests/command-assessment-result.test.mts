import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  separateCommandAssessment,
  toolContentForModel,
} = require('../src/services/command-assessment-result.ts');
const { getWorkLog } = require('../src/services/intermediate-messages.ts');

const directory = await mkdtemp(join(tmpdir(), 'chatter-command-diagnostics-'));
process.env.API_DB_PATH = join(directory, 'test.sqlite');
const { db } = await import('../src/db.js');
const { appendChatMessage, createUserChat, getChatMessages, getHistoryForAi } =
  await import('../src/services/chats.js');
const assessment = {
  status: 'ready' as const,
  approved: false,
  auto: 0.61,
  know: 0.7,
  thresholds: { auto: 0.15, know: 0.8 },
};
const result = { status: 'success', command: 'echo example', output: 'A'.repeat(2000) };
try {
  db.prepare("INSERT INTO users(id,name,status,is_admin) VALUES (81,'Owner','approved',1)").run();
  for (const name of ['execute_pc_command', 'execute_ssh_command']) {
    const raw = JSON.stringify({ ...result, auto_confirmation: assessment });
    const separated = separateCommandAssessment(name, raw);
    assert.deepEqual(
      JSON.parse(separated.content),
      result,
      'model output preserves the execution result',
    );
    assert.deepEqual(separated.assessment, assessment);
    assert.doesNotMatch(separated.content, /auto_confirmation|thresholds/);
    const trace = [
      {
        step: 1,
        content: '',
        tool_calls: [{ id: 'cmd', name, arguments: { command: result.command } }],
        results: [
          { id: 'cmd', name, content: separated.content, assessment: separated.assessment },
        ],
      },
    ];
    const work = getWorkLog(trace);
    assert.equal(work[0].type, 'tool');
    if (work[0].type === 'tool') {
      assert.deepEqual(
        work[0].call.assessment,
        assessment,
        'scores survive independently of a 250-character preview',
      );
      assert.doesNotMatch(work[0].call.result_preview!, /auto_confirmation|thresholds/);
    }
    const chatId = createUserChat(81, name);
    await appendChatMessage(81, chatId, 'user', 'Run it');
    await appendChatMessage(
      81,
      chatId,
      'assistant',
      'Done',
      null,
      null,
      null,
      null,
      JSON.stringify(trace),
    );
    const message = getChatMessages(81, chatId).find((message) => message.role === 'assistant')!;
    assert.deepEqual(message.tool_calls?.[0].assessment, assessment);
    assert.deepEqual(
      message.work_log?.find((entry) => entry.type === 'tool')?.call.assessment,
      assessment,
    );
    const history = getHistoryForAi(81, chatId);
    assert.doesNotMatch(JSON.stringify(history), /auto_confirmation|thresholds|"assessment"/);
    const command = history.find((entry: any) => entry.role === 'tool');
    assert.deepEqual(JSON.parse(command.content), result);

    // Existing messages stored diagnostics inside the result JSON.
    const legacyChatId = createUserChat(81, name + ' legacy');
    const legacyTrace = [{ ...trace[0], results: [{ id: 'cmd', name, content: raw }] }];
    await appendChatMessage(81, legacyChatId, 'user', 'Run it');
    await appendChatMessage(
      81,
      legacyChatId,
      'assistant',
      'Done',
      null,
      null,
      null,
      null,
      JSON.stringify(legacyTrace),
    );
    assert.doesNotMatch(
      JSON.stringify(getHistoryForAi(81, legacyChatId)),
      /auto_confirmation|thresholds|"assessment"/,
    );
    const legacy = getChatMessages(81, legacyChatId).find(
      (message) => message.role === 'assistant',
    )!;
    assert.deepEqual(legacy.tool_calls?.[0].assessment, assessment);

    const delegation = JSON.stringify({ answer: 'Done', subagentTrace: { iterations: trace } });
    for (const tool of ['invoke_subagent', 'spawn_subagent']) {
      assert.doesNotMatch(
        toolContentForModel(tool, delegation),
        /auto_confirmation|thresholds|"assessment"/,
      );
      const nested = JSON.stringify({
        subagentTrace: { iterations: [{ results: [{ name: tool, content: delegation }] }] },
      });
      assert.doesNotMatch(
        toolContentForModel(tool, nested),
        /auto_confirmation|thresholds|assessment/,
      );
    }
  }
  assert.deepEqual(separateCommandAssessment('read_file', 'unchanged'), { content: 'unchanged' });
  assert.deepEqual(separateCommandAssessment('execute_pc_command', 'plain output'), {
    content: 'plain output',
  });
  console.log(
    'PASS: separate command diagnostics, durable UI metadata, long output, clean model history and nested subagents',
  );
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
