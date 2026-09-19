import { runImageGeneration } from '../../image-generation.js';
import type { Tool } from '../types.js';

/**
 * generate_image tool — text-to-image and image-to-image generation.
 *
 * The base64 payload is NOT returned in the tool result: generated images are
 * pushed into the per-request `generatedImages` side channel (see ToolContext)
 * so the LLM context is not flooded with megabytes of base64. The model only
 * receives a textual stub with the reusable image_url.
 */
export const generateImageTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text description. Call ONLY if the user directly asks to "draw", "create an image", "generate a picture", etc. If the user writes in a non-English language — translate the prompt to English for better quality, but respond to the user in their language. STRICTLY FORBIDDEN to write JSON with action/actioninput/dalle in the response text — use ONLY the tool call. Supports image-to-image: if the user attached a photo and asks to edit/modify it — include image_url.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of what to depict or how to modify the attached image (in English for best generation quality).'
          },
          image_url: {
            type: 'array',
            items: { type: 'string' },
            description: 'Image URL(s) from [Attached image N: URL] markers in the current message or chat history. Use for image-to-image generation (editing/modifying the attached photo).'
          },
          aspect_ratio: {
            type: 'string',
            enum: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '1:2', '2:1', '1:4', '4:1', '1:8', '8:1', '9:21', '21:9', '9:19.5', '19.5:9', '9:20', '20:9'],
            default: 'auto',
            description: 'Output aspect ratio. Use auto unless the user requests a square, portrait, landscape, phone-screen, or ultrawide format.'
          }
        },
        required: ['prompt']
      }
    }
  },
  handler: async (args, context) => {
    const user = context.user;
    if (!user) return 'Tool error: user context is unavailable.';
    const billingUser = context.billingUser || user;
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return 'Error: empty prompt for image generation.';

    // Collect reference images by URL(s) from chat history or current message
    let selectedImages: Array<{ base64: string; mimeType: string }> = [];
    const rawImageUrl: unknown = args.image_url;
    const urls: string[] = Array.isArray(rawImageUrl)
      ? rawImageUrl.filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map(u => u.trim())
      : (typeof rawImageUrl === 'string' && rawImageUrl.trim() ? [rawImageUrl.trim()] : []);

    if (urls.length > 0) {
      const { resolveImageFile, filenameFromUrl } = await import('../../image-storage.js');
      const fs = await import('node:fs');
      const nodePath = await import('node:path');
      for (const url of urls) {
        const filename = filenameFromUrl(url);
        if (!filename) continue;
        const filepath = resolveImageFile(filename);
        if (!filepath) continue;
        const buf = fs.readFileSync(filepath);
        const ext = nodePath.extname(filename).toLowerCase();
        const mimeType = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/jpeg';
        selectedImages.push({ base64: buf.toString('base64'), mimeType });
      }
    }

    selectedImages = selectedImages.slice(0, 3);

    const result = await runImageGeneration(
      billingUser.id,
      prompt,
      selectedImages.length > 0 ? selectedImages : undefined,
      args.aspect_ratio,
    );
    if (!result.ok) return `Image generation error: ${(result as any).error || 'unknown'}`;
    // base64 НЕ возвращаем в tool_content — он сохраняется в массив generatedImages
    // LLM получает текстовую заглушку, чтобы не забивать контекст мегабайтами base64
    const generatedImages = context.generatedImages;
    if (Array.isArray(generatedImages)) {
      // Save to disk and get URL
      let imageUrl: string | undefined;
      try {
        const { saveImageAsset } = await import('../../media-assets.js');
        const saved = await saveImageAsset({
          userId: user.id,
          data: result.image_base64,
          retention: 'temporary',
          kind: 'generated',
        });
        imageUrl = saved.url;
      } catch (err) {
        console.error('[generate_image] failed to save generated image to disk:', err);
      }
      generatedImages.push({ image_base64: result.image_base64, image_url: imageUrl, prompt_used: result.prompt_used });
    }
    return JSON.stringify({
      status: 'success',
      message: 'Image generated successfully and attached to the response. The image_url can be reused in a later generate_image call to edit this image.',
      image_url: generatedImages?.[generatedImages.length - 1]?.image_url ?? null,
    });
  },
};
