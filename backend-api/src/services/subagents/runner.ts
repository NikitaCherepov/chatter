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

import { SubagentContext, SubagentResult, SubagentIteration } from './types.js';
import { setMaxListeners } from 'events';
import { getSubagent, RegisteredSubagent } from './registry.js';

// These will be set by initSubagentRunner() at startup to avoid circular imports.
let _runCompletion: typeof import('../ai.js').runCompletion;
let _runTool: typeof import('../ai.js').runTool;
let _throwIfAborted: typeof import('../ai.js').throwIfAborted;
let _withAbort: typeof import('../ai.js').withAbort;
let _toolDefinitions: typeof import('../ai.js').toolDefinitions;

type RunCompletionFn = (mode: 'pro' | 'lite' | 'vision-pro' | 'vision-lite', requestPayload: Record<string, unknown>, manualModel?: any, signal?: AbortSignal, reasoningLevel?: any) => Promise<any>;
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
  // Shared tools
  list_directory: 'Читаю директорию...',
  convert_video: 'Конвертирую видео...',
  list_devops_servers: 'Получение списка серверов...',
};

function getToolStatusMessage(agentName: string, toolName: string): string {
  const base = TOOL_STATUS_MESSAGES[toolName];
  return base ? `[${agentName}] ${base}` : `[${agentName}] ${toolName}...`;
}

/** Local abort-error check (avoids circular import with ai.ts). */
function _isAbortError(err: any): boolean {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || `${err?.message || ''}` === 'AbortError';
}

/** Лимит на сохраняемый полный результат инструмента в trace (аналог TOOL_RESULT_FULL_MAX в ai.ts). */
const SUBAGENT_TOOL_RESULT_MAX = 40_000;

function truncateToolResult(content: string): string {
  if (content.length > SUBAGENT_TOOL_RESULT_MAX) {
    return content.slice(0, SUBAGENT_TOOL_RESULT_MAX) + `\n\n[...результат обрезан, всего ${content.length} символов]`;
  }
  return content;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunSubagentParams {
  /** Subagent name from the registry. Mutually exclusive with `agent`. */
  agentName?: string;
  /** Ready-to-run subagent (e.g. ad-hoc). Mutually exclusive with `agentName`. */
  agent?: RegisteredSubagent;
  /** The task description from the main agent. */
  task: string;
  /** Extra context / data from the main agent. */
  context?: Record<string, any>;
  /** Execution context (userId, desktop, etc.). */
  ctx: SubagentContext;
}

/**
 * Resolve effective mode from user settings.
 * 'auto' = inherit from main agent (always 'pro' for the API call;
 *   actual model selection happens via manualModel fallback chain).
 * 'manual' = use user's preferred_model (ctx.manualModel), still 'pro' API mode.
 */
function resolveMode(ctx: SubagentContext): 'pro' {
  // Оба режима используют 'pro' API — разница только в том,
  // передаётся ли manualModel в runCompletion.
  // manualModel уже прокинут через ctx и применяется автоматически ниже.
  return 'pro';
}

/**
 * Run a subagent to completion and return its result.
 *
 * This function is called from the main agent's `runTool` handler for `invoke_subagent`.
 */
export async function runSubagent(params: RunSubagentParams): Promise<SubagentResult> {
  const { agentName, agent: directAgent, task, context, ctx } = params;

  if (!_runCompletion || !_runTool) {
    throw new Error('Subagent runner not initialised. Call initSubagentRunner() first.');
  }

  _throwIfAborted(ctx.signal);

  // The subagent loop can accumulate many abort listeners on the shared signal
  // (each withAbort + runCompletion + runTool adds one). Raise the limit to avoid
  // the MaxListenersExceededWarning — these are not leaks, they clean up after each call.
  if (ctx.signal) {
    try { setMaxListeners(100, ctx.signal); } catch {}
  }

  // Resolve user's preferred model (manual model selection)
  const manualModel = ctx.subagentMode === 'manual' ? (ctx.manualModel || undefined) : undefined;
  const reasoningLevel = (ctx.subagentReasoningLevel === 'auto' ? null : (ctx.subagentReasoningLevel ?? null)) as import('../ai.js').ReasoningLevel | null;

  // 1. Resolve agent config — either from registry or direct (ad-hoc)
  const agent: RegisteredSubagent = directAgent || getSubagent(agentName!);
  const resolvedAgentName = agent.name;

  // 2. Build tool list: own tools + shared tools from main agent
  const ownTools = agent.ownTools || [];
  const ownToolDefs = ownTools.map(t => t.definition);
  // Resolve shared tool definitions: prefer runtime defs (includes serverOnlyTools, desktopOnlyTools, etc.),
  // fall back to the static _toolDefinitions if runtime defs weren't provided.
  const sharedToolSource = (ctx.runtimeToolDefs && ctx.runtimeToolDefs.length > 0)
    ? ctx.runtimeToolDefs
    : (_toolDefinitions as unknown as any[]);
  const sharedToolDefs = sharedToolSource.filter(
    (t: any) => agent.sharedTools.includes(t?.function?.name || '')
  );

  const allToolDefs = [...ownToolDefs, ...sharedToolDefs];

  // Create a lookup for own tools
  const ownToolsMap = new Map(ownTools.map(t => [t.definition.function.name, t]));

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
  const iterations: SubagentIteration[] = [];
  const mode = resolveMode(ctx);
  const maxLoops = agent.maxLoops;
  const debugRaw = process.env.DEBUG_AI_RAW_SUBAGENT === '1';

  try {
  for (let loop = 0; loop < maxLoops; loop++) {
    _throwIfAborted(ctx.signal);

    // Inject "wrap up" nudge near the limit
    if (loop === maxLoops - 2) {
      messages.push({
        role: 'system',
        content: 'У тебя осталось 2 итерации. Заверши задачу и верни итоговый результат.',
      });
    }

    console.log(`[subagent:${resolvedAgentName}] === loop ${loop + 1}/${maxLoops} === (messages: ${messages.length})`);

    // Call AI — use user's preferred model if set, otherwise agent's configured mode
    const requestPayload: Record<string, unknown> = {
        messages,
        max_tokens: 8192,
      };
      if (allToolDefs.length > 0) {
        requestPayload.tools = allToolDefs;
        requestPayload.tool_choice = 'auto';
      }

    const completion = await _withAbort(
      _runCompletion(mode, requestPayload, manualModel, ctx.signal, reasoningLevel),
      ctx.signal,
    );

    const response = completion?.response;
    const message = response?.choices?.[0]?.message;
    if (!message) {
      console.warn(`[subagent:${resolvedAgentName}] empty response from model`);
      return {
        answer: 'Субагент не получил ответ от модели.',
        summary: 'Пустой ответ модели.',
        toolCallsHistory,
        iterations,
      };
    }

    // Debug: log raw model response
    if (debugRaw) {
      try {
        console.log(`[subagent:${resolvedAgentName}][RAW]`, JSON.stringify(response, null, 2));
      } catch (err) {
        console.warn(`[subagent:${resolvedAgentName}][RAW] serialization failed:`, err);
      }
    }

    // Log assistant text (reasoning / intermediate message)
    if (message.content) {
      const text = String(message.content);
      console.log(`[subagent:${resolvedAgentName}][text] ${text.slice(0, 2000)}`);
    }

    // Push assistant message to history
    messages.push(message);

    // Start a new iteration trace entry
    const currentIteration: SubagentIteration = {
      step: loop + 1,
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: [],
      results: [],
    };

    // If no tool calls — we have the final answer
    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const content = message.content || '';
      console.log(`[subagent:${resolvedAgentName}] === finished after ${loop + 1} loops, answer: ${content.slice(0, 500)}`);
      currentIteration.is_final = true;
      iterations.push(currentIteration);
      return {
        answer: content,
        summary: content.slice(0, 500),
        toolCallsHistory,
        iterations,
      };
    }

    // Process tool calls
    for (const toolCall of toolCalls) {
      _throwIfAborted(ctx.signal);

      const toolName = toolCall.function?.name || '';
      const argsRaw = toolCall.function?.arguments || '{}';
      let toolContent: string;

      // Log tool call with arguments
      console.log(`[subagent:${resolvedAgentName}][tool_call] ${toolName}(${argsRaw.slice(0, 500)})`);

      // Broadcast tool status to client
      const statusMsg = getToolStatusMessage(resolvedAgentName, toolName);
      if (ctx.onToolStatus) {
        try { await ctx.onToolStatus(statusMsg); } catch {}
      }

      // Check if it's an own tool
      const ownTool = ownToolsMap.get(toolName);
      if (ownTool) {
        // Execute own tool handler directly
        try {
          const parsedArgs = JSON.parse(argsRaw);
          // Inject subagent context (server_id, api_token, port, etc.) into ctx
          const ctxForTool = { ...ctx, subagentContext: context };
          toolContent = await _withAbort(
            ownTool.handler(parsedArgs, ctxForTool),
            ctx.signal,
          );
        } catch (err: any) {
          if (_isAbortError(err)) throw err;
          console.warn(`[subagent:${resolvedAgentName}] own tool "${toolName}" error:`, err?.message || err);
          toolContent = JSON.stringify({ status: 'error', message: err?.message || String(err) });
        }
      } else if (agent.sharedTools.includes(toolName)) {
        // Shared tool — delegate to the main agent's runTool
        // This ensures auto-approve policies, HitL confirmations, sudo passwords, etc.
        // Pass the full canonical account record for plan checks and feature flags.
        const userRecord = ctx.user || { id: ctx.userId } as any;

        try {
          toolContent = await _withAbort(
            _runTool(
              userRecord,
              ctx.timezoneOffset,
              toolName,
              argsRaw,
              // aiCall — used by some tools like update_core_memory for sub-AI calls
              (payload) => _runCompletion(mode, payload, manualModel, ctx.signal, reasoningLevel),
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
          if (_isAbortError(err)) throw err;
          console.warn(`[subagent:${resolvedAgentName}] shared tool "${toolName}" error:`, err?.message || err);
          toolContent = JSON.stringify({ status: 'error', message: err?.message || String(err) });
        }
      } else {
        toolContent = JSON.stringify({
          status: 'error',
          message: `Инструмент "${toolName}" недоступен для этого субагента.`,
        });
      }

      // Log tool result
      console.log(`[subagent:${resolvedAgentName}][tool_result] ${toolName} -> ${toolContent.slice(0, 1000)}`);

      // Record flat history
      let parsedArgs: any;
      try { parsedArgs = JSON.parse(argsRaw); } catch { parsedArgs = { _raw: argsRaw }; }
      toolCallsHistory.push({ tool: toolName, args: parsedArgs, result: toolContent });

      // Record in iteration trace (with full result, truncated)
      try {
        currentIteration.tool_calls.push({ id: toolCall.id, name: toolName, arguments: parsedArgs });
      } catch {
        currentIteration.tool_calls.push({ id: toolCall.id, name: toolName, arguments: { _raw: argsRaw } });
      }
      currentIteration.results.push({ id: toolCall.id, name: toolName, content: truncateToolResult(toolContent) });

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

    // Save completed iteration
    iterations.push(currentIteration);
  }

  // If we exhausted all loops without a final answer
  return {
    answer: 'Субагент превысил лимит итераций. Задача может быть выполнена частично.',
    summary: 'Превышен лимит итераций.',
    toolCallsHistory,
    iterations,
  };
  } catch (err: any) {
    // Soft abort: возвращаем partial-результат вместо throw,
    // чтобы основной агент получил tool_result и мог продолжить.
    if (_isAbortError(err)) {
      console.log(`[subagent:${resolvedAgentName}] aborted, returning partial result (${toolCallsHistory.length} tool calls performed)`);
      const partialAnswer = messages
        .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
        .map(m => m.content)
        .pop() as string | undefined;
      return {
        answer: partialAnswer || 'Прервано пользователем',
        summary: 'Прервано пользователем (partial).',
        toolCallsHistory,
        iterations,
        aborted: true,
      };
    }
    throw err;
  }
}
