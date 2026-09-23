import type { Plan } from '../core/events.ts';
import { fail, ok, type Tool } from './types.ts';

/**
 * A tool whose implementation is "stop, and wait for a person".
 *
 * From the model's side this is an ordinary tool call. From the harness's side
 * it suspends the loop on a promise the surface resolves — a terminal picker
 * interactively, a printed block plus an answers file in CI.
 */
export const askUser: Tool = {
  name: 'ask_user',
  category: 'human',
  description:
    'Ask the human a question and wait for their answer. Use when a choice is genuinely theirs.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      context: { type: 'string', description: 'Why you are asking.' },
    },
    required: ['question'],
  },
  async run(input, ctx) {
    const question = String(input.question ?? '').trim();
    if (!question) return fail('ask_user requires a question');

    const answer = await ctx.surface.ask({
      question,
      options: Array.isArray(input.options) ? input.options.map(String) : undefined,
      context: input.context ? String(input.context) : undefined,
    });
    return ok(`The human answered: ${answer}`);
  },
};

/**
 * The plan → build handoff. One human approval produces two state changes:
 * the mode flips out of read-only, and the approved steps become the todo list.
 */
export const exitPlanMode: Tool = {
  name: 'exit_plan_mode',
  category: 'human',
  description:
    'Present a plan for approval. On approval the harness switches from read-only plan mode to build mode and seeds your todo list with the steps.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'steps'],
  },
  async run(input, ctx) {
    if (ctx.state.mode !== 'plan') {
      return fail('already in build mode — nothing to approve');
    }

    const plan: Plan = {
      summary: String(input.summary ?? ''),
      steps: (Array.isArray(input.steps) ? input.steps : []).map((s) => ({ text: String(s) })),
    };
    if (plan.steps.length === 0) return fail('a plan needs at least one step');

    ctx.session.proposePlan(plan);
    const answer = await ctx.surface.approvePlan(plan);

    if (!answer.approved) {
      return ok(
        `Plan rejected. Stay in plan mode and revise. The human said: ${answer.reason || '(no reason given)'}`,
      );
    }

    ctx.session.switchMode('build', 'plan approved');
    ctx.session.seedTodosFromPlan(plan);
    return ok(
      `Plan approved. Mode is now BUILD (writes and commands are unlocked) and your todo list has been seeded with ${plan.steps.length} steps. Work through them and mark each completed.`,
    );
  },
};
