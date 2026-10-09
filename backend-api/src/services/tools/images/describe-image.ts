import { materializeAssetInput } from '../../response-attachments.js';
import type { Tool, ToolDefinition } from '../types.js';

/** Build describe_image tool — sends image(s) to vision model for analysis */
export const buildDescribeImageTool = (supportsDirectView = false): ToolDefinition => {
  const properties: Record<string, unknown> = {
    question: {
      type: 'string',
      description: 'Specific task or question (e.g.: "Describe the image", "Read the text").'
    },
    image_url: {
      type: 'string',
      description: 'REQUIRED. Exact public URL or stored relative /api/v1/images/... URL of the image to analyze.'
    },
  };
  if (supportsDirectView) {
    properties.mode = {
      type: 'string',
      enum: ['description', 'direct'],
      default: 'description',
      description: 'description returns a text analysis from a vision helper. direct loads the pixels into your own next turn so you can inspect them yourself.',
    };
  }
  return {
    type: 'function' as const,
    function: {
      name: 'describe_image',
      description: 'Analyzes the specified image using a vision model. Supports web image URLs, user photos, and images from chat history. DO NOT call this tool if the image is already visible in your context. Read, translate, and analyze it yourself.',
      parameters: {
        type: 'object',
        properties,
        required: ['question', 'image_url']
      }
    }
  };
};

export const describeImageTool: Tool = {
  definition: buildDescribeImageTool(false),
  handler: async (args, context) => {
    const question: string = typeof args.question === 'string' ? args.question.trim() : '';
    const imageUrl: string | undefined = typeof args.image_url === 'string' ? args.image_url.trim() || undefined : undefined;

    if (!question) return JSON.stringify({ status: 'error', message: 'question is required — specify what you need to know about the image.' });

    try {
      // Collect images to analyze.
      // Priority: 1) explicit image_url param 2) current request context.userImages 3) load from disk by URL
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

      if (args.mode === 'direct') {
        if (!context.currentModelSupportsVision || !context.directImageSink) {
          return JSON.stringify({ status: 'error', message: 'Direct image viewing is unavailable for this model. Use description mode.' });
        }
        for (const image of imagesToAnalyze) {
          context.directImageSink.items.push({ ...image, question, localUrl });
        }
        return JSON.stringify({
          status: 'loaded_for_direct_view',
          images_loaded: imagesToAnalyze.length,
          image_url: localUrl ?? imageUrl ?? null,
        });
      }

      const visionMessages = [
        {
          role: 'system',
          content: `You are a vision analyst. Analyze the user's image(s) and complete the requested task.
Respond in the user's language. Be detailed and precise.`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            ...imagesToAnalyze.map(img => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
            }))
          ]
        }
      ];

      const visionResp = await context.runVisionCompletion!({
        messages: visionMessages,
        max_tokens: 2000,
      });

      const visionText = visionResp.response?.choices?.[0]?.message?.content || '';

      return JSON.stringify({
        status: 'success',
        images_analyzed: imagesToAnalyze.length,
        vision_result: visionText,
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', message: `Image analysis error: ${err?.message || String(err)}` });
    }
  },
};
