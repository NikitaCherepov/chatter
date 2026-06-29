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
  /** Full user record — needed for plan checks, feature flags, linked_tg_id, etc. in shared tools. */
  user?: any;
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
  /** User's subagent mode preference: 'auto' (inherit from main agent) or 'manual' (use user's preferred_model). */
  subagentMode?: SubagentMode;
  /** User's reasoning level preference for subagent completions. */
  subagentReasoningLevel?: string | null;
  /** Extra context data passed from the main agent when invoking the subagent (e.g. server_id, api_token, port). */
  subagentContext?: Record<string, any>;
  /** Optional: called by spawn_subagent handler when the subagent finishes, to capture the full trace for UI display. */
  onSubagentTrace?: (trace: SubagentTraceEntry) => void;
}

/** Одна итерация агентского цикла субагента (аналог ToolIteration основного агента). */
export interface SubagentIteration {
  step: number;
  /** Текст, который модель сгенерила на этой итерации (intermediate content). Может быть "". */
  content: string;
  /** Tool calls на этой итерации. */
  tool_calls: Array<{ id?: string; name: string; arguments: any }>;
  /** Полные результаты для каждого tool_call этой итерации. */
  results: Array<{ id?: string; name: string; content: string }>;
  /** true у финальной итерации без tool_calls (только текстовый ответ). */
  is_final?: boolean;
}

/** Trace entry for ad-hoc subagent — stored in messages.subagents_json for UI display. */
export interface SubagentTraceEntry {
  task: string;
  system_prompt: string;
  tools: string[];
  tools_used: string[];
  answer: string;
  summary: string;
  aborted?: boolean;
  /** Итерации агентского цикла (аналог ToolIteration основного агента). */
  iterations: SubagentIteration[];
}

/** Result returned from a finished subagent run. */
export interface SubagentResult {
  /** The final text answer from the subagent. */
  answer: string;
  /** Short human-readable summary of what the subagent did. */
  summary: string;
  /** Full history of tool calls the subagent performed (flat list, for backwards compat). */
  toolCallsHistory: Array<{ tool: string; args: Record<string, any>; result: string }>;
  /** Iterations of the agent loop (step-by-step with results, for trace/UI). */
  iterations: SubagentIteration[];
  /** Present and `true` when the subagent was aborted mid-run (soft abort). */
  aborted?: boolean;
}

/** Mode selection for subagent AI calls. Set by user in settings, not by the model. */
export type SubagentMode = 'auto' | 'manual';

/** Static configuration of a subagent, stored in the registry or built ad-hoc. */
export interface SubagentConfig {
  name: string;
  /** Short description the main agent uses to decide WHEN to delegate. */
  description: string;
  /** Path to the system prompt .md file (relative to prompts/ dir). Used for static registry entries. */
  promptFile?: string;
  /** Direct system prompt text — used for ad-hoc subagents (no file needed). */
  systemPromptText?: string;
  /** Tools exclusive to this subagent. Empty/omitted for ad-hoc subagents. */
  ownTools?: SubagentTool[];
  /** Names of shared tools from the main agent's toolDefinitions the subagent may use. */
  sharedTools: string[];
  /** Maximum agent-loop iterations for this subagent. */
  maxLoops: number;
}
