import type { UserRecord } from '../../types.js';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ToolContext {
  userId: number;
  user?: UserRecord;
  billingUser?: UserRecord;
  chatId?: number;
  originMessageCursor?: number;
  timezoneOffset: number;
  signal?: AbortSignal;
  /**
   * Per-request side channel for generated images. Base64 payloads are pushed
   * here instead of being returned in the tool result, so the LLM context is
   * not flooded with megabytes of base64. Consumed by the response pipeline.
   */
  generatedImages?: Array<{ image_base64: string; image_url?: string; prompt_used: string }>;
}

export interface Tool<TContext extends ToolContext = ToolContext> {
  definition: ToolDefinition;
  handler: (args: Record<string, any>, context: TContext) => Promise<string>;
}
