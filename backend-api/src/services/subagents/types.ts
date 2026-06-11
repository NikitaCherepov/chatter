/**
 * Subagent system types.
 *
 * A subagent is a narrow-scoped AI agent with its own system prompt,
 * a restricted set of tools, and a single task delegated by the main Chatter agent.
 */

/** OpenAI-compatible tool definition shape. */
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

/** A tool paired with its handler function. */
export interface SubagentTool {
  definition: ToolDefinition;
  handler: (args: Record<string, any>, ctx: SubagentContext) => Promise<string>;
}

/** Context passed into every subagent run — mirrors the relevant parts of the main agent context. */
export interface SubagentContext {
  userId: number;
  isDesktop: boolean;
  timezoneOffset: number;
  signal?: AbortSignal;
  /** Sink for pushing desktop actions (confirmation cards, etc.) out of band. */
  desktopActionSink?: { value: any | null };
  /** Callback the runner calls when a desktop_action is produced by a shared tool. */
  onDesktopAction?: (action: any) => Promise<void> | void;
  /** Broadcast tool status to the client (SSE / WS), same as onToolStatus in the main agent. */
  onToolStatus?: (text: string) => Promise<void> | void;
  /** User's preferred model (from manual model selection), passed through from the main agent. */
  manualModel?: any;
}

/** Result returned from a finished subagent run. */
export interface SubagentResult {
  /** The final text answer from the subagent. */
  answer: string;
  /** Short human-readable summary of what the subagent did. */
  summary: string;
  /** Full history of tool calls the subagent performed (name → result). */
  toolCallsHistory: Array<{ tool: string; args: Record<string, any>; result: string }>;
}

/** Static configuration of a subagent, stored in the registry. */
export interface SubagentConfig {
  name: string;
  /** Short description the main agent uses to decide WHEN to delegate. */
  description: string;
  /** Path to the system prompt .md file (relative to prompts/ dir). */
  promptFile: string;
  /** Tools exclusive to this subagent. */
  ownTools: SubagentTool[];
  /** Names of shared tools from the main agent's toolDefinitions the subagent may use. */
  sharedTools: string[];
  /** Maximum agent-loop iterations for this subagent. */
  maxLoops: number;
  /** Which completion mode to use: 'pro' (default) or 'lite'. */
  mode?: 'pro' | 'lite';
}
