export type DirectToolImage = {
  base64: string;
  mimeType: string;
  question: string;
  localUrl?: string;
};

export const buildToolImageMessage = (images: DirectToolImage[]) => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: images.map((image, index) => `Image ${index + 1}: ${image.question}`).join('\n'),
    },
    ...images.map(image => ({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    })),
  ],
});
