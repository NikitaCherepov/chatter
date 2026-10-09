import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-describe-image-'));
process.env.API_DB_PATH = path.join(tempDir, 'test.db');
process.env.ENCRYPTION_KEY = 'describe-image-test-key';

const { buildDescribeImageTool, describeImageTool } = await import('../src/services/tools/images/describe-image.js');
const { getModularTool } = await import('../src/services/tools/registry.js');
const { db } = await import('../src/db.js');

try {
  for (const supportsDirectView of [false, true]) {
    const definition = buildDescribeImageTool(supportsDirectView);
    assert.deepEqual(definition.function.parameters.required, ['question', 'image_url']);
    assert.match(definition.function.description, /DO NOT call this tool if the image is already visible in your context\. Read, translate, and analyze it yourself\./);
    assert.equal('mode' in definition.function.parameters.properties, supportsDirectView);
  }
  assert.equal(buildDescribeImageTool(true).function.parameters.properties.mode.default, 'description');
  assert.equal(getModularTool('describe_image'), describeImageTool);

  const images = [{ base64: 'test-image', mimeType: 'image/png' }];
  let calls = 0;
  const context = {
    userId: 1,
    timezoneOffset: 0,
    userImages: images,
    runVisionCompletion: async (request: Record<string, any>) => {
      calls++;
      assert.equal(request.max_tokens, 2000);
      assert.equal(request.messages[1].content[0].text, 'Read the text');
      assert.equal(request.messages[1].content[1].image_url.url, 'data:image/png;base64,test-image');
      return { response: { choices: [{ message: { content: 'Recognized text' } }] } };
    },
  };
  const description = JSON.parse(await describeImageTool.handler({ question: 'Read the text' }, context));
  assert.equal(description.status, 'success');
  assert.equal(description.vision_result, 'Recognized text');
  assert.equal(calls, 1);

  const directImageSink = { items: [] as Array<{ base64: string; mimeType: string; question: string; localUrl?: string }> };
  const direct = JSON.parse(await describeImageTool.handler({ question: 'Read the text', mode: 'direct' }, {
    ...context, currentModelSupportsVision: true, directImageSink,
  }));
  assert.equal(direct.status, 'loaded_for_direct_view');
  assert.equal(directImageSink.items[0].base64, 'test-image');
  assert.equal(calls, 1, 'direct view must not call a separate vision model');

  const unsupported = JSON.parse(await describeImageTool.handler({ question: 'Read the text', mode: 'direct' }, context));
  assert.equal(unsupported.status, 'error');
  assert.equal(calls, 1);
  const missingQuestion = JSON.parse(await describeImageTool.handler({}, context));
  assert.equal(missingQuestion.status, 'error');
  const missingImage = JSON.parse(await describeImageTool.handler({ question: 'Read the text' }, { userId: 1, timezoneOffset: 0 }));
  assert.equal(missingImage.status, 'error');
  console.log('describe-image tests passed');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
