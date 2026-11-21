import { materializeAssetInput } from '../../response-attachments.js';
import type { Tool, ToolDefinition } from '../types.js';

export const buildDescribeImageTool = (): ToolDefinition => ({
  type: 'function',
  function: {
    name: 'describe_image',
    description: 'Inspect an image from a web URL, a user photo, or chat history. You automatically receive the image itself when you support image input, or a text analysis otherwise. DO NOT call this tool if the image is already visible in your context.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Specific task or question (e.g.: "Describe the image", "Read the text").',
        },
        image_url: {
          type: 'string',
          description: 'Exact public URL or stored relative /api/v1/images/... URL of the image to analyze.',
        },
      },
      required: ['question', 'image_url'],
    },
  },
});

export const describeImageTool: Tool = {
  definition: buildDescribeImageTool(),
  handler: async (args, context) => {
    const question: string = typeof args.question === 'string' ? args.question.trim() : '';
    const imageUrl: string | undefined = typeof args.image_url === 'string' ? args.image_url.trim() || undefined : undefined;

    if (!question) return JSON.stringify({ status: 'error', message: 'question is required — specify what you need to know about the image.' });

    try {
      type ImgData = { base64: string; mimeType: string };
      let imagesToAnalyze: ImgData[] = [];

      let localUrl: string | undefined;
      if (imageUrl) {
        const materialized = await materializeAssetInput(context.userId, { url: imageUrl, retention: 'temporary' });
        if (materialized.kind !== 'image') {
          return JSON.stringify({ status: 'error', message: 'The supplied reference is not an image.' });
        }
        localUrl = materialized.localUrl;
        imagesToAnalyze = [{ base64: materialized.buffer.toString('base64'), mimeType: materialized.mimeType }];
      } else if (context.userImages && context.userImages.length > 0) {
        // From current request
        imagesToAnalyze = context.userImages;
      }

      if (imagesToAnalyze.length === 0) {
        return JSON.stringify({ status: 'error', message: 'Image is unavailable. It may have been deleted or not yet saved.' });
      }
      imagesToAnalyze = await Promise.all(imagesToAnalyze.map(async image => {
        if (image.mimeType !== 'image/gif') return image;
        const sharp = (await import('sharp')).default;
        const firstFrame = await sharp(Buffer.from(image.base64, 'base64'), { failOn: 'none' })
          .webp({ quality: 85 })
          .toBuffer();
        return { base64: firstFrame.toString('base64'), mimeType: 'image/webp' };
      }));

      if (context.currentModelSupportsVision) {
        const { directImageSink } = context;
        if (!directImageSink) {
          return JSON.stringify({ status: 'error', message: 'Image input is unavailable in this run.' });
        }
        for (const image of imagesToAnalyze) {
          directImageSink.items.push({ ...image, question, localUrl });
        }
        return JSON.stringify({
          status: 'loaded_for_direct_view',
          images_loaded: imagesToAnalyze.length,
          image_url: localUrl ?? imageUrl ?? null,
        });
      }

      if (!context.runVisionCompletion) {
        return JSON.stringify({ status: 'error', message: 'Image analysis is unavailable in this run.' });
      }
      const visionResponse = await context.runVisionCompletion({
        messages: [
          {
            role: 'system',
            content: "You are a vision analyst. Analyze the user's image(s) and complete the requested task. Respond in the user's language. Be detailed and precise.",
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: question },
              ...imagesToAnalyze.map(image => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              })),
            ],
          },
        ],
        max_tokens: 2000,
      });
      return JSON.stringify({
        status: 'success',
        images_analyzed: imagesToAnalyze.length,
        vision_result: visionResponse.response?.choices?.[0]?.message?.content || '',
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Image analysis error: ${err?.message || String(err)}` });
    }
  },
};
