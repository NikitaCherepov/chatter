import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { DirectToolImage } from '../src/services/tools/image-input.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-describe-image-'));
process.env.API_DB_PATH = path.join(tempDir, 'test.db');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.ENCRYPTION_KEY = 'describe-image-test-key';

const { buildDescribeImageTool, describeImageTool } = await import('../src/services/tools/images/describe-image.js');
const { getModularTool } = await import('../src/services/tools/registry.js');
const { db } = await import('../src/db.js');
const { normalizeTokenUsage, runTool, refreshConfiguredModels, sendMessageThroughAi } = await import('../src/services/ai.js');
const { importModelKey, updateModelSettings } = await import('../src/services/model-settings.js');

const { initSubagentRunner, runSubagent } = await import('../src/services/subagents/runner.js');
const originalFetch = globalThis.fetch;

try {
  const definition = buildDescribeImageTool();
  assert.deepEqual(definition.function.parameters.required, ['question', 'image_url']);
  assert.deepEqual(Object.keys(definition.function.parameters.properties), ['question', 'image_url']);
  assert.match(definition.function.description, /DO NOT call this tool if the image is already visible/);
  assert.equal(getModularTool('describe_image'), describeImageTool);

  db.prepare("INSERT INTO users (id, name, status, plan, is_admin) VALUES (1, 'Owner', 'approved', 'free', 1)").run();
  const { updateMemoryPreferences } = await import('../src/services/memory-preferences.js');
  updateMemoryPreferences(1, { automatic_memory: false });
  const imageUrl = 'https://192.0.2.1/photo.png';
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' },
  }).png().toBuffer();
  let downloads = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), imageUrl);
    downloads++;
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
  };

  const context = { userId: 1, timezoneOffset: 0 };
  const args = { question: 'Read the text', image_url: imageUrl };
  const directImageSink = { items: [] as DirectToolImage[] };

  const visionContext = { ...context, currentModelSupportsVision: true, directImageSink };
  const result = JSON.parse(await describeImageTool.handler(args, visionContext));
  assert.equal(result.status, 'loaded_for_direct_view', result.message);
  assert.equal(result.images_loaded, 1);
  assert.match(result.image_url, /^\/api\/v1\/images\//);
  assert.equal(downloads, 1);
  assert.deepEqual(directImageSink.items, [{
    base64: png.toString('base64'),
    mimeType: 'image/png',
    question: args.question,
    localUrl: result.image_url,
  }]);

  const oldArgs = { question: 'Inspect the stored photo', image_url: result.image_url, mode: 'description' };
  const stored = JSON.parse(await describeImageTool.handler(oldArgs, visionContext));
  assert.equal(stored.status, 'loaded_for_direct_view', stored.message);
  assert.equal(directImageSink.items[1].question, oldArgs.question);
  assert.equal(downloads, 1, 'a stored image URL should not trigger a network request');

  for (const invalidArgs of [{}, { question: 'Read the text' }]) {
    assert.equal(JSON.parse(await describeImageTool.handler(invalidArgs, visionContext)).status, 'error');
  }
  assert.equal(JSON.parse(await describeImageTool.handler(args, {
    ...visionContext, directImageSink: undefined,
  })).status, 'error');

  const baseUrl = 'https://image-provider.test/v1';
  const apiKeyId = importModelKey('Fake provider', 'image-test-key');
  const model = {
    id: 'image-model',
    uniqueId: 'image-model',
    model: 'image-test-upstream',
    baseUrl,
    apiKeyId,
    accessMode: 'all',
    supportsTools: true,
  } as const;
  const helperModel = {
    ...model,
    id: 'helper-model',
    uniqueId: 'helper-model',
    model: 'image-helper-upstream',
    supportsVision: true,
  };
  updateModelSettings({ visionModel: helperModel });
  refreshConfiguredModels();

  const imagePart = {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
  };
  const description = 'The image is red.';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  let helperCalls = 0;
  const describeImage = (payload: Record<string, any>) => {
    assert.equal(payload.model, helperModel.model);
    assert.deepEqual(payload.messages.at(-1).content, [
      { type: 'text', text: oldArgs.question },
      imagePart,
    ]);
    helperCalls++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: description } }], usage });
  };
  const assertDescription = (message: { role: string; content: string }) => {
    assert.equal(message.role, 'tool');
    assert.deepEqual(JSON.parse(message.content), {
      status: 'success', images_analyzed: 1, vision_result: description,
    });
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${baseUrl}/chat/completions`);
    return describeImage(JSON.parse(String(init?.body)));
  };

  for (const supportsVision of [false, true]) {
    const previousHelperCalls = helperCalls;
    const callArgs = { ...oldArgs, mode: supportsVision ? 'description' : 'direct' };
    let completions = 0;
    initSubagentRunner({
      runCompletion: async (_mode, payload) => {
        completions++;
        if (completions === 1) {
          assert.deepEqual(payload.tools, [definition]);
          return { response: { choices: [{ message: {
            content: null,
            tool_calls: ['first', 'second'].map(id => ({
              id,
              type: 'function',
              function: { name: 'describe_image', arguments: JSON.stringify(callArgs) },
            })),
          } }] } };
        }
        assert.equal(completions, 2);
        const messages = payload.messages as Array<{ role: string; content: string }>;
        if (supportsVision) {
          assert.deepEqual(messages.slice(-3).map(message => message.role), ['tool', 'tool', 'user']);
          assert.deepEqual(messages.at(-1)?.content, [
            { type: 'text', text: `Image 1: ${oldArgs.question}\nImage 2: ${oldArgs.question}` },
            imagePart,
            imagePart,
          ]);
        } else {
          messages.slice(-2).forEach(assertDescription);
        }
        return { response: { choices: [{ message: { content: 'Image inspected' } }] } };
      },
      runTool,
      throwIfAborted: (signal) => signal?.throwIfAborted(),
      withAbort: async (promise) => promise,
      toolDefinitions: [definition],
      modelSupportsVision: () => supportsVision,
      normalizeTokenUsage,
    });
    const response = await runSubagent({
      agent: {
        name: 'image_test',
        description: 'Inspect an image',
        systemPrompt: 'Inspect an image',
        sharedTools: ['describe_image'],
        maxLoops: 4,
      },
      task: 'Inspect the stored photo',
      ctx: { ...context, isDesktop: false },
    });
    assert.equal(response.answer, 'Image inspected');
    assert.equal(response.toolCallsHistory.length, 2);
    assert.equal(helperCalls - previousHelperCalls, supportsVision ? 0 : 2);
  }

  for (const supportsVision of [false, true]) {
    const previousHelperCalls = helperCalls;
    const callArgs = { ...oldArgs, mode: supportsVision ? 'description' : 'direct' };
    updateModelSettings({ manualModels: [{ ...model, supportsVision }] });
    refreshConfiguredModels();
    const requests: Array<Record<string, any>> = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), `${baseUrl}/chat/completions`);
      const payload = JSON.parse(String(init?.body));
      if (payload.model === helperModel.model) return describeImage(payload);
      assert.equal(payload.model, model.model);
      requests.push(payload);
      const toolCall = requests.length === 1 ? {
        id: 'describe-photo',
        type: 'function',
        function: { name: 'describe_image', arguments: JSON.stringify(callArgs) },
      } : undefined;
      const message = toolCall
        ? { role: 'assistant', content: null, tool_calls: [toolCall] }
        : { role: 'assistant', content: 'Finished' };
      const finishReason = toolCall ? 'tool_calls' : 'stop';
      if (!payload.stream) {
        return Response.json({ choices: [{ message, finish_reason: finishReason }], usage });
      }
      const delta = toolCall ? { ...message, tool_calls: [{ index: 0, ...toolCall }] } : message;
      const chunk = { id: 'image-test', object: 'chat.completion.chunk', created: 1, model: payload.model };
      const events = [
        { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
        { ...chunk, choices: [], usage },
      ];
      const stream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(stream + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    await sendMessageThroughAi(1, 'Inspect the stored photo', undefined, {
      preferredModel: model.uniqueId,
      forcePro: true,
      skipHistory: true,
      countAsUserMessage: false,
      allowedTools: ['describe_image'],
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools, [definition]);
    assert.equal(helperCalls - previousHelperCalls, supportsVision ? 0 : 1);
    const input = requests[1].messages.at(-1);
    if (supportsVision) {
      assert.equal(input.role, 'user');
      assert.deepEqual(input.content, [
        { type: 'text', text: `Image 1: ${oldArgs.question}` },
        imagePart,
      ]);
    } else {
      assertDescription(input);
    }
  }

  console.log('describe-image tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
