/**
 * Subagent runner — executes a subagent's agent loop.
 *
 * This is a self-contained agent loop that:
 * 1. Loads the subagent's system prompt and tools
 * 2. Sends the task to the AI model
 * 3. Processes tool calls in a loop until the model returns a final answer
 * 4. Returns the result to the calling main agent
 *
 * Reuses the main agent's `runCompletion` for AI calls and `runTool` for shared tools.
 * Broadcasts tool status via onToolStatus (same SSE channel as the main agent).
 * Respects user's preferred model (manual model selection).
 */

import { SubagentContext, SubagentResult } from './types.js';
import { getSubagent, RegisteredSubagent } from './registry.js';

// These will be set by initSubagentRunner() at startup to avoid circular imports.
let _runCompletion: typeof import('../ai.js').runCompletion;
let _runTool: typeof import('../ai.js').runTool;
let _throwIfAborted: typeof import('../ai.js').throwIfAborted;
let _withAbort: typeof import('../ai.js').withAbort;
let _toolDefinitions: typeof import('../ai.js').toolDefinitions;

type RunCompletionFn = (mode: 'pro' | 'lite' | 'vision-pro' | 'vision-lite', requestPayload: Record<string, unknown>, manualModel?: any, signal?: AbortSignal) => Promise<any>;
type RunToolFn = (user: any, timezoneOffset: number, toolName: string, argsRaw: string, aiCall: (payload: Record<string, unknown>) => Promise<any>, generatedImages?: any[], displayStateSink?: any, desktopActionSink?: any, mapUpdateSink?: any, activeMacros?: any[], signal?: AbortSignal) => Promise<string>;

/**
 * Initialise the runner with references to the main ai.ts internals.
 * Called once at server startup to break the circular dependency.
 */
export function initSubagentRunner(deps: {
  runCompletion: RunCompletionFn;
  runTool: RunToolFn;
  throwIfAborted: (signal?: AbortSignal) => void;
  withAbort: <T>(promise: Promise<T>, signal?: AbortSignal) => Promise<T>;
  toolDefinitions: readonly any[];
}): void {
  _runCompletion = deps.runCompletion as any;
  _runTool = deps.runTool as any;
  _throwIfAborted = deps.throwIfAborted;
  _withAbort = deps.withAbort;
  _toolDefinitions = deps.toolDefinitions as any;
}

// ---------------------------------------------------------------------------
// Human-readable tool names for status broadcasting
// ---------------------------------------------------------------------------

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  execute_ssh_command: 'Выполнение команды на сервере...',
  list_devops_servers: 'Получение списка серверов...',
};

function getToolStatusMessage(agentName: string, toolName: string): string {
  const base = TOOL_STATUS_MESSAGES[toolName];
  return base ? `[${agentName}] ${base}` : `[${agentName}] ${toolName}...`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunSubagentParams {
  /** Subagent name from the registry. */
  agentName: string;
  /** The task description from the main agent. */
  task: string;
  /** Extra context / data from the main agent. */
  context?: Record<string, any>;
  /** Execution context (userId, desktop, etc.). */
  ctx: SubagentContext;
}

/**
 * Run a subagent to completion and return its result.
 *
 * This function is called from the main agent's `runTool` handler for `invoke_subagent`.
 */
export async function runSubagent(params: RunSubagentParams): Promise<SubagentResult> {
  const { agentName, task, context, ctx } = params;

  if (!_runCompletion || !_runTool) {
    throw new Error('Subagent runner not initialised. Call initSubagentRunner() first.');
  }

  _throwIfAborted(ctx.signal);

  // Resolve user's preferred model (manual model selection)
  const manualModel = ctx.manualModel || undefined;

  // 1. Resolve agent config
  const agent: RegisteredSubagent = getSubagent(agentName);

  // 2. Build tool list: own tools + shared tools from main agent
  const ownToolDefs = agent.ownTools.map(t => t.definition);
  const sharedToolDefs = (_toolDefinitions as unknown as any[]).filter(
    (t: any) => agent.sharedTools.includes(t?.function?.name || '')
  );

  const allToolDefs = [...ownToolDefs, ...sharedToolDefs];

  // Create a lookup for own tools
  const ownToolsMap = new Map(agent.ownTools.map(t => [t.definition.function.name, t]));

  // 3. Build messages
  const userMessageParts = [`Задача: ${task}`];
  if (context) {
    userMessageParts.push(`Контекст: ${JSON.stringify(context)}`);
  }

  const messages: any[] = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: userMessageParts.join('\n\n') },
  ];

  // 4. Agent loop
  const toolCallsHistory: SubagentResult['toolCallsHistory'] = [];
  const mode = agent.mode || 'pro';
  const maxLoops = agent.maxLoops;

  for (let loop = 0; loop < maxLoops; loop++) {
    _throwIfAborted(ctx.signal);

    // Inject "wrap up" nudge near the limit
    if (loop === maxLoops - 2) {
      messages.push({
        role: 'system',
        content: 'У тебя осталось 2 итерации. Заверши задачу и верни итоговый результат.',
      });
    }

    console.log(`[subagent:${agentName}] loop ${loop + 1}/${maxLoops}, messages: ${messages.length}`);

    // Call AI — use user's preferred model if set, otherwise agent's configured mode
    const completion = await _withAbort(
      _runCompletion(mode, {
        messages,
        tools: allToolDefs,
        tool_choice: 'auto',
        max_tokens: 8192,
      }, manualModel, ctx.signal),
      ctx.signal,
    );

    const response = completion?.response;
    const message = response?.choices?.[0]?.message;
    if (!message) {
      console.warn(`[subagent:${agentName}] empty response from model`);
      return {
        answer: 'Субагент не получил ответ от модели.',
        summary: 'Пустой ответ модели.',
        toolCallsHistory,
      };
    }

    // Push assistant message to history
    messages.push(message);

    // If no tool calls — we have the final answer
    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const content = message.content || '';
      console.log(`[subagent:${agentName}] finished after ${loop + 1} loops, answer length: ${content.length}`);
      return {
        answer: content,
        summary: content.slice(0, 500),
        toolCallsHistory,
      };
    }

    console.log(`[subagent:${agentName}] loop ${loop + 1}: ${toolCalls.length} tool call(s): ${toolCalls.map((tc: any) => tc.function?.name).join(', ')}`);

    // Process tool calls
    for (const toolCall of toolCalls) {
      _throwIfAborted(ctx.signal);

      const toolName = toolCall.function?.name || '';
      const argsRaw = toolCall.function?.arguments || '{}';
      let toolContent: string;

      // Broadcast tool status to client
      const statusMsg = getToolStatusMessage(agentName, toolName);
      if (ctx.onToolStatus) {
        try { await ctx.onToolStatus(statusMsg); } catch {}
      }

      // Check if it's an own tool
      const ownTool = ownToolsMap.get(toolName);
      if (ownTool) {
        // Execute own tool handler directly
        try {
          const parsedArgs = JSON.parse(argsRaw);
          toolContent = await _withAbort(
            ownTool.handler(parsedArgs, ctx),
            ctx.signal,
          );
        } catch (err: any) {
          console.warn(`[subagent:${agentName}] own tool "${toolName}" error:`, err?.message || err);
          toolContent = JSON.stringify({ status: 'error', message: err?.message || String(err) });
        }
      } else if (agent.sharedTools.includes(toolName)) {
        // Shared tool — delegate to the main agent's runTool
        // This ensures auto-approve policies, HitL confirmations, sudo passwords, etc.
        const minimalUser = { id: ctx.userId } as any;

        try {
          toolContent = await _withAbort(
            _runTool(
              minimalUser,
              ctx.timezoneOffset,
              toolName,
              argsRaw,
              // aiCall — used by some tools like update_core_memory for sub-AI calls
              (payload) => _runCompletion(mode, payload, manualModel, ctx.signal),
              [],       // generatedImages
              undefined, // displayStateSink
              ctx.desktopActionSink, // desktopActionSink — enables HitL confirmations
              undefined, // mapUpdateSink
              undefined, // activeMacros
              ctx.signal,
            ),
            ctx.signal,
          );
        } catch (err: any) {
          console.warn(`[subagent:${agentName}] shared tool "${toolName}" error:`, err?.message || err);
          toolContent = JSON.stringify({ status: 'error', message: err?.message || String(err) });
        }
      } else {
        toolContent = JSON.stringify({
          status: 'error',
          message: `Инструмент "${toolName}" недоступен для этого субагента.`,
        });
      }

      // Record history
      try {
        toolCallsHistory.push({
          tool: toolName,
          args: JSON.parse(argsRaw),
          result: toolContent,
        });
      } catch {
        toolCallsHistory.push({ tool: toolName, args: { _raw: argsRaw }, result: toolContent });
      }

      // Push tool result to messages
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolContent,
      });

      // Dispatch desktop action if shared tool produced one
      if (ctx.desktopActionSink?.value && ctx.onDesktopAction) {
        await ctx.onDesktopAction(ctx.desktopActionSink.value);
        ctx.desktopActionSink.value = null;
      }
    }
  }

  // If we exhausted all loops without a final answer
  return {
    answer: 'Субагент превысил лимит итераций. Задача может быть выполнена частично.',
    summary: 'Превышен лимит итераций.',
    toolCallsHistory,
  };
}
