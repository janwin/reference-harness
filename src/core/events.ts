/**
 * Every mutation of a thread is an event. Nothing changes thread state except by
 * appending one of these to the log. That single rule is what makes persistence,
 * crash recovery and multi-surface following fall out for free.
 */

export type Mode = 'plan' | 'build';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface MemorySettings {
  /** Whether prior turns are carried into the model context at all. */
  enabled: boolean;
  /** How many transcript messages to keep in-context before eliding. */
  windowMessages: number;
  /** Durable notes the agent chose to remember across turns. */
  notes: string[];
}

/** A persisted "always allow" answer from an earlier permission prompt. */
export interface Grant {
  tool: string;
  /** Path prefix for write tools, command prefix for exec tools, '*' for any. */
  scope: string;
  grantedAt: string;
}

export type PermissionEffect = 'allow' | 'deny' | 'ask';

export interface PlanStep {
  text: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export type TurnStatus = 'completed' | 'interrupted' | 'error' | 'incomplete';

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  text: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool-result messages. */
  toolCallId?: string;
  /** Marks messages the harness injected rather than the human typing them. */
  synthetic?: boolean;
  /**
   * How a human message arrived. 'queued' means it was typed while the agent was
   * already working — steering an in-flight turn rather than starting one.
   */
  source?: 'typed' | 'queued';
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type HarnessEventBody =
  | { type: 'thread_created'; cwd: string; model: string; mode: Mode }
  | { type: 'user_message'; text: string; synthetic?: boolean; source?: 'typed' | 'queued' }
  | { type: 'assistant_message'; text: string; toolCalls?: ToolCall[] }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; output: string }
  | {
      type: 'permission_decision';
      callId: string;
      tool: string;
      effect: PermissionEffect;
      rule: string;
      reason: string;
      /** What the human answered, when the effect was `ask`. */
      resolution?: 'approved' | 'approved_always' | 'rejected';
    }
  | { type: 'mode_changed'; from: Mode; to: Mode; reason: string }
  | { type: 'model_changed'; from: string; to: string }
  | { type: 'tokens'; usage: TokenUsage; source: string }
  | { type: 'todos_updated'; todos: Todo[] }
  | { type: 'memory_updated'; settings: MemorySettings }
  | { type: 'grant_added'; grant: Grant }
  | { type: 'turn_started'; turnId: string }
  | { type: 'turn_ended'; turnId: string; status: TurnStatus }
  | { type: 'subagent_started'; subagentId: string; kind: 'isolated' | 'fork'; prompt: string }
  | {
      type: 'subagent_finished';
      subagentId: string;
      kind: 'isolated' | 'fork';
      report: string;
      usage: TokenUsage;
    }
  | { type: 'plan_proposed'; plan: Plan }
  | { type: 'note'; text: string };

export type HarnessEvent = HarnessEventBody & {
  seq: number;
  ts: string;
};

export const emptyUsage = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export const totalTokens = (u: TokenUsage): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite;
