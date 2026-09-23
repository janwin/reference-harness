import type { Plan, Todo, TokenUsage } from '../core/events.ts';
import type { ThreadState } from '../core/state.ts';
import type { ToolCategory } from '../perms/chain.ts';
import type { Surface } from '../surfaces/types.ts';

export interface ToolResult {
  ok: boolean;
  output: string;
}

/**
 * The slice of the session a tool is allowed to touch. Tools never write the
 * event log directly — they go through here, so every side effect is recorded.
 */
export interface SessionApi {
  setTodos(todos: Todo[]): void;
  proposePlan(plan: Plan): void;
  switchMode(to: 'plan' | 'build', reason: string): void;
  seedTodosFromPlan(plan: Plan): void;
  runSubagent(opts: {
    kind: 'isolated' | 'fork';
    prompt: string;
    signal: AbortSignal;
  }): Promise<{ report: string; usage: TokenUsage }>;
}

export interface ToolContext {
  cwd: string;
  state: ThreadState;
  signal: AbortSignal;
  surface: Surface;
  session: SessionApi;
}

export interface Tool {
  name: string;
  category: ToolCategory;
  description: string;
  /** JSON Schema, passed straight to the Anthropic API as the tool's input schema. */
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const ok = (output: string): ToolResult => ({ ok: true, output });
export const fail = (output: string): ToolResult => ({ ok: false, output });
