import { getUserById } from './chats.js';
import { ensureUtilityAiQuota, resolveManualModel, type ReasoningLevel } from './ai.js';
import { getPlanLimits } from './plan-limits.js';
import { calculateChargedTokens, chargeTokens, checkQuota } from './token-quota.js';
import { getSubagent, type RegisteredSubagent } from './subagents/registry.js';
import { runSubagent } from './subagents/runner.js';
import type {
  SubagentContext,
  SubagentIteration,
  SubagentTool,
  SubagentTraceEntry,
  ToolDefinition,
} from './subagents/types.js';
import type { MessageUsage, TokenUsageCall, UserRecord } from '../types.js';

export type AgentTool = SubagentTool;

export type RunAgentParams = {
  userId: number;
  name: string;
  systemPrompt: string;
  input: string;
  tools?: AgentTool[];
  maxLoops?: number;
  maxTokens?: number;
  preferredModel?: string | null;
  reasoningLevel?: ReasoningLevel | null;
  timezoneOffset?: number;
  signal?: AbortSignal;
  onToolStatus?: (text: string) => Promise<void> | void;
  onStreamToken?: (text: string) => Promise<void> | void;
  onReasoningStream?: (text: string) => Promise<void> | void;
};

export type RunAgentResult = {
  finalText: string;
  aborted: boolean;
  toolCalls: Array<{ tool: string; args: Record<string, any>; result: string }>;
  iterations: SubagentIteration[];
  usage: MessageUsage | null;
  usageCalls: Array<TokenUsageCall & { agentName: string }>;
};

export type InvokeSubagentLifecycle = {
  onStart?: (data: { agent: string; task: string; context?: unknown }) =>
    | Promise<{ id?: number; signal?: AbortSignal } | void>
    | { id?: number; signal?: AbortSignal }
    | void;
  onFinish?: (data: {
    id?: number;
    agent: string;
    task: string;
    trace?: SubagentTraceEntry;
    error?: string;
  }) => Promise<void> | void;
};

const normalizeReasoningLevel = (value: unknown): ReasoningLevel | null => {
  if (value === 'none' || value === 'minimal' || value === 'low' || value === 'medium'
    || value === 'high' || value === 'xhigh' || value === 'auto') return value;
  return null;
};

const buildUsage = (calls: TokenUsageCall[]): MessageUsage | null => {
  if (calls.length === 0) return null;
  const aggregate = calls.reduce((sum, call) => ({
    prompt_tokens: sum.prompt_tokens + call.prompt_tokens,
    completion_tokens: sum.completion_tokens + call.completion_tokens,
    total_tokens: sum.total_tokens + call.total_tokens,
    cache_hit_tokens: sum.cache_hit_tokens + call.cache_hit_tokens,
    cache_miss_tokens: sum.cache_miss_tokens + call.cache_miss_tokens,
    reasoning_tokens: sum.reasoning_tokens + call.reasoning_tokens,
  }), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    reasoning_tokens: 0,
  });
  const latest = calls[calls.length - 1];
  return {
    latest: {
      prompt_tokens: latest.prompt_tokens,
      completion_tokens: latest.completion_tokens,
      total_tokens: latest.total_tokens,
      cache_hit_tokens: latest.cache_hit_tokens,
      cache_miss_tokens: latest.cache_miss_tokens,
      reasoning_tokens: latest.reasoning_tokens,
    },
    aggregate,
    calls,
  };
};

const chargeAgentCall = (userId: number, agentName: string, call: TokenUsageCall) => {
  chargeTokens({
    userId,
    route: `agent:${agentName}`,
    modelId: call.uniqueId || call.model || null,
    modelName: call.model || null,
    providerName: call.provider || null,
    promptTokens: call.prompt_tokens,
    completionTokens: call.completion_tokens,
    cacheHitTokens: call.cache_hit_tokens,
    cacheMissTokens: call.cache_miss_tokens,
    reasoningTokens: call.reasoning_tokens,
    totalTokens: call.total_tokens,
    upstreamProviderSlug: call.upstreamProviderSlug ?? null,
    actualCostUsd: call.actualCostUsd ?? null,
  });
};

/**
 * Runs one independent agent with an explicit prompt and explicit tool set.
 * It does not create a chat, load chat history, or inherit Chatter's tool list.
 */
export const runAgent = async (params: RunAgentParams): Promise<RunAgentResult> => {
  const user = getUserById(params.userId);
  if (!user) throw new Error('user_not_found');
  const preferredModelId = params.preferredModel !== undefined
    ? params.preferredModel
    : (user.preferred_model ?? null);
  ensureUtilityAiQuota(params.userId, preferredModelId, 'pro');

  const manualModel = preferredModelId
    ? resolveManualModel(preferredModelId, user.is_admin === 1)
    : undefined;
  const usageCalls: Array<TokenUsageCall & { agentName: string }> = [];
  const billingMode = getPlanLimits(user.plan).billing_mode;
  const onUsageCall = (agentName: string, usage: TokenUsageCall) => {
    usageCalls.push({ ...usage, agentName });
    chargeAgentCall(params.userId, agentName, usage);
  };
  const shouldStopForQuota = (latest: TokenUsageCall) => {
    if (user.is_admin === 1) return false;
    if (calculateChargedTokens(latest.total_tokens, latest.uniqueId || latest.model).isFree) return false;
    return !checkQuota(params.userId, false, billingMode).ok;
  };

  const agent: RegisteredSubagent = {
    name: params.name,
    description: `Independent agent: ${params.name}`,
    systemPromptText: params.systemPrompt,
    systemPrompt: params.systemPrompt,
    ownTools: params.tools || [],
    sharedTools: [],
    maxLoops: Math.max(1, Math.floor(params.maxLoops || 32)),
    maxTokens: Math.max(256, Math.floor(params.maxTokens || 8192)),
  };
  const result = await runSubagent({
    agent,
    task: params.input,
    ctx: {
      userId: params.userId,
      user,
      isDesktop: false,
      timezoneOffset: params.timezoneOffset ?? (Number(user.timezone_offset) || 0),
      signal: params.signal,
      onToolStatus: params.onToolStatus,
      manualModel,
      subagentMode: manualModel ? 'manual' : 'auto',
      subagentReasoningLevel: params.reasoningLevel !== undefined
        ? params.reasoningLevel
        : normalizeReasoningLevel(user.reasoning_level),
      onStreamToken: params.onStreamToken,
      onReasoningStream: params.onReasoningStream,
      onUsageCall,
      shouldStopForQuota,
    },
  });

  const flatCalls = usageCalls.map(({ agentName: _agentName, ...call }) => call);
  return {
    finalText: result.answer,
    aborted: !!result.aborted,
    toolCalls: result.toolCallsHistory,
    iterations: result.iterations,
    usage: buildUsage(flatCalls),
    usageCalls,
  };
};

const resolveChildModel = (user: UserRecord) => {
  const configuredId = user.subagent_mode && user.subagent_mode !== 'auto'
    ? user.subagent_mode
    : null;
  return configuredId ? resolveManualModel(configuredId, user.is_admin === 1) : undefined;
};

/** Creates an invoke_subagent tool whose visible and executable agents are both allowlisted. */
export const createInvokeSubagentTool = (options: {
  allowedSubagents: string[];
  lifecycle?: InvokeSubagentLifecycle;
}): AgentTool => {
  const allowed = [...new Set(options.allowedSubagents.map(name => name.trim()).filter(Boolean))];
  if (allowed.length === 0) throw new Error('invoke_subagent_requires_allowed_agents');
  const agents = allowed.map(getSubagent);
  const allowedSet = new Set(allowed);
  const description = agents.map(agent => `"${agent.name}" — ${agent.description}`).join('\n');
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'invoke_subagent',
      description: `Delegate a focused task to one of these subagents:\n${description}`,
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: allowed, description: 'Allowed subagent name.' },
          task: { type: 'string', description: 'A focused, self-contained task for the subagent.' },
          context: { type: 'object', description: 'Optional structured context for the task.' },
        },
        required: ['agent', 'task'],
      },
    },
  };

  return {
    definition,
    handler: async (args: Record<string, any>, parentCtx: SubagentContext) => {
      const agentName = typeof args.agent === 'string' ? args.agent.trim() : '';
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      const context = args.context && typeof args.context === 'object' ? args.context : undefined;
      if (!allowedSet.has(agentName)) {
        return JSON.stringify({ status: 'error', message: `Subagent "${agentName}" is not allowed.` });
      }
      if (!task) return JSON.stringify({ status: 'error', message: 'task is required' });

      let lifecycle: { id?: number; signal?: AbortSignal } | undefined;
      try {
        lifecycle = (await options.lifecycle?.onStart?.({ agent: agentName, task, context })) || undefined;
        const childPreferredModel = parentCtx.user?.subagent_mode && parentCtx.user.subagent_mode !== 'auto'
          ? parentCtx.user.subagent_mode
          : null;
        ensureUtilityAiQuota(parentCtx.userId, childPreferredModel, 'pro');
        const childModel = parentCtx.user ? resolveChildModel(parentCtx.user as UserRecord) : undefined;
        const result = await runSubagent({
          agentName,
          task,
          context,
          ctx: {
            ...parentCtx,
            signal: lifecycle?.signal || parentCtx.signal,
            manualModel: childModel,
            subagentMode: childModel ? 'manual' : 'auto',
            subagentReasoningLevel: normalizeReasoningLevel(parentCtx.user?.subagent_reasoning_level),
            runtimeToolDefs: undefined,
            onStreamToken: undefined,
            onReasoningStream: undefined,
          },
        });
        const registered = getSubagent(agentName);
        const trace: SubagentTraceEntry = {
          task,
          system_prompt: registered.systemPrompt.slice(0, 2000),
          tools: registered.sharedTools,
          tools_used: result.toolCallsHistory.map(call => call.tool),
          answer: result.answer,
          summary: result.summary,
          aborted: result.aborted,
          iterations: result.iterations,
          usage: result.usage || null,
        };
        await options.lifecycle?.onFinish?.({ id: lifecycle?.id, agent: agentName, task, trace });
        return JSON.stringify({
          status: result.aborted ? 'cancelled' : 'success',
          answer: result.answer,
          summary: result.summary,
          tools_used: result.toolCallsHistory.map(call => call.tool),
          subagentTrace: trace,
        });
      } catch (error: any) {
        const message = error?.message || String(error);
        await options.lifecycle?.onFinish?.({ id: lifecycle?.id, agent: agentName, task, error: message });
        return JSON.stringify({ status: 'error', message: `Subagent error ${agentName}: ${message}` });
      }
    },
  };
};
