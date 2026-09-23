import type { Message, Mode, TokenUsage, ToolCall } from '../core/events.ts';
import type { Tool } from '../tools/types.ts';

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: Tool[];
  mode: Mode;
  signal: AbortSignal;
  /** Subagents get a different script; real providers ignore this. */
  role?: 'main' | 'subagent';
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** Rough token estimate, good enough for a counter the human reads. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function estimateRequestTokens(req: ModelRequest): number {
  const body = req.messages
    .map((m) => m.text + JSON.stringify(m.toolCalls ?? []))
    .join('\n');
  return estimateTokens(req.system + body) + req.tools.length * 60;
}
