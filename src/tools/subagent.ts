import { totalTokens } from '../core/events.ts';
import { fail, ok, type Tool } from './types.ts';

/**
 * Two shapes of delegation, and the difference is the whole point:
 *
 *  - `isolated` gets a fresh context. It cannot see the parent's reasoning, so
 *    its review is not anchored by it. That costs a cold prompt cache.
 *  - `fork` inherits the parent's message prefix verbatim, so the provider can
 *    reuse the cached prefix. Cheap and fast, but it shares the parent's biases.
 */
export const spawnSubagent: Tool = {
  name: 'spawn_subagent',
  category: 'meta',
  description:
    "Delegate to a subagent. kind='isolated' for an unbiased second opinion (fresh context); kind='fork' to continue from this conversation's context (keeps the prompt cache warm).",
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['isolated', 'fork'] },
      prompt: { type: 'string' },
    },
    required: ['kind', 'prompt'],
  },
  async run(input, ctx) {
    const kind = input.kind === 'fork' ? 'fork' : 'isolated';
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) return fail('spawn_subagent requires a prompt');

    const { report, usage } = await ctx.session.runSubagent({
      kind,
      prompt,
      signal: ctx.signal,
    });

    return ok(
      [
        `[${kind} subagent — ${totalTokens(usage)} tokens, ${usage.cacheRead} read from cache]`,
        report,
      ].join('\n'),
    );
  },
};
