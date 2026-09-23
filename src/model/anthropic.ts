import Anthropic from '@anthropic-ai/sdk';

import type { Message, ToolCall } from '../core/events.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from './provider.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5';

type ApiMessage = Anthropic.Messages.MessageParam;

/**
 * The real thing. Note how little of the harness this file touches: the loop,
 * the chain, the todo gate and persistence are all provider-agnostic, and
 * swapping this for ScriptedProvider changes nothing but where tokens come from.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  private client: Anthropic;

  constructor(model: string = DEFAULT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Run with --model scripted to use the offline provider.',
      );
    }
    this.name = model;
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create(
      {
        model: this.name,
        max_tokens: 2048,
        // Caching the system block is what makes a forked subagent cheap: it
        // replays the same prefix, so the provider bills it as cache_read.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        tools: req.tools.map((tool, index) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters as Anthropic.Messages.Tool.InputSchema,
          ...(index === req.tools.length - 1
            ? { cache_control: { type: 'ephemeral' as const } }
            : {}),
        })),
        messages: toApiMessages(req.messages),
      },
      { signal: req.signal },
    );

    const text = response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const toolCalls: ToolCall[] = response.content
      .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    return {
      text,
      toolCalls,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/**
 * Our transcript is a flat list; the API wants alternating roles with tool
 * results batched into the following user turn. Translate here so nothing else
 * in the harness has to know the wire format.
 */
export function toApiMessages(messages: Message[]): ApiMessage[] {
  const out: ApiMessage[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      pushContent(out, 'user', [{ type: 'text', text: message.text || '(no content)' }]);
      continue;
    }

    if (message.role === 'assistant') {
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      if (message.text.trim()) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      if (content.length) pushContent(out, 'assistant', content);
      continue;
    }

    pushContent(out, 'user', [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? 'unknown',
        content: message.text || '(no output)',
      },
    ]);
  }

  return out;
}

function pushContent(
  out: ApiMessage[],
  role: 'user' | 'assistant',
  content: Anthropic.Messages.ContentBlockParam[],
): void {
  const last = out.at(-1);
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(...content);
    return;
  }
  out.push({ role, content });
}
