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
  timezoneOffset: number;
  signal?: AbortSignal;
}

export interface Tool<TContext extends ToolContext = ToolContext> {
  definition: ToolDefinition;
  handler: (args: Record<string, any>, context: TContext) => Promise<string>;
}
