import type { AppearanceMessageContent, AppearanceToolCall } from '../../main/appearance-shell-types';
import type { ToolCall, WorkLogStep } from './api';
import { describeToolCall } from './tool-activity';
import { splitWorkContent, workLogSteps } from './work-log-content';

/** Project the same work log as the native conversation, without imposing its markup. */
export function appearanceMessageContent(message: {
  role: string; content: string; reasoning_content?: string | null;
  intermediate_messages?: string[]; work_log?: WorkLogStep[]; tool_calls?: ToolCall[] | null; tool_status?: string | null;
}, streaming: boolean, toolLabel: (name: string) => string): AppearanceMessageContent {
  const work = splitWorkContent(message.content, message.intermediate_messages);
  const projectTool = (call: ToolCall): AppearanceToolCall => {
    const activity = describeToolCall(call);
    return {
      ...(call.id ? { id: call.id } : {}), name: call.name, label: toolLabel(call.name),
      kind: activity.kind, target: activity.target,
      status: call.running ? 'running' : activity.status,
      internal: activity.internal, confirmed: activity.confirmed, arguments: call.arguments,
      ...(call.result_preview !== undefined ? { resultPreview: call.result_preview } : {}),
      children: (call.agent_tools ?? []).map(projectTool),
    };
  };
  return {
    content: message.role === 'assistant' ? work.answer : message.content,
    reasoningContent: message.reasoning_content ?? '', streaming, toolStatus: message.tool_status ?? null,
    workLog: message.role === 'assistant' ? workLogSteps(work.messages, message.work_log, message.tool_calls)
      .map(step => step.type === 'tool' ? { type: 'tool', call: projectTool(step.call) } : { type: step.type, text: step.text }) : [],
  };
}
