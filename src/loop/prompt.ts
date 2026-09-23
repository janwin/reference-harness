import type { Message } from '../core/events.ts';
import type { ThreadState } from '../core/state.ts';
import { TODO_MARKER } from '../model/scripted.ts';

export const SYSTEM_BASE = `You are the example agent inside a demonstration harness.

Your job is deliberately simple: survey the working directory and write a NOTES.md
that describes what it contains. The interesting machinery is the harness around
you — persistence, permissions, interrupts, task tracking — not the task itself.

Rules you must follow:
- In PLAN mode you may only read. Propose a plan with exit_plan_mode and wait.
- In BUILD mode, keep the task list honest with todo_write as you go.
- Ask the human with ask_user when a decision is genuinely theirs.
- Do not claim you are finished while task-list items are open.`;

/**
 * Builds the system prompt fresh from thread state every turn, so state is the
 * source of truth for what the model believes — not the other way round.
 */
export function buildSystemPrompt(state: ThreadState): string {
  const lines = [
    SYSTEM_BASE,
    '',
    `Working directory: ${state.cwd}`,
    `Mode: ${state.mode.toUpperCase()}${state.mode === 'plan' ? ' (read-only — writes and commands are blocked by the approval chain)' : ' (writes and commands are available, subject to approval)'}`,
  ];

  if (state.plan) {
    lines.push('', 'Approved plan:', state.plan.summary);
  }

  if (state.memory.enabled && state.memory.notes.length) {
    lines.push('', 'Remembered across turns:', ...state.memory.notes.map((n) => `- ${n}`));
  }

  lines.push('', 'Current task list:');
  lines.push(
    state.todos.length
      ? state.todos.map((t) => `- [${t.status}] ${t.text}`).join('\n')
      : '(empty — write one with todo_write before multi-step work)',
  );
  // Machine-readable copy, so the offline scripted provider can read the same
  // state the wording above describes.
  lines.push(`${TODO_MARKER}${JSON.stringify(state.todos)}`);

  return lines.join('\n');
}

/**
 * Context assembly, honouring the thread's memory settings. Note that the
 * transcript on disk is never truncated — only what we *send* is.
 */
export function buildContext(state: ThreadState): Message[] {
  if (!state.memory.enabled) {
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    return lastUser ? [lastUser] : [];
  }

  const window = state.memory.windowMessages;
  if (state.messages.length <= window) return state.messages;

  const head = state.messages.slice(0, 1);
  let tail = state.messages.slice(-window);

  // Never start the tail on a tool result whose tool_use block got cut off.
  while (tail.length && tail[0]?.role === 'tool') tail = tail.slice(1);

  return [
    ...head,
    { role: 'user', text: `[${state.messages.length - tail.length - head.length} earlier messages elided by the memory window]`, synthetic: true },
    ...tail,
  ];
}

export function gateNudge(open: string[]): string {
  return [
    '[harness] You said you were done, but the task list still has open items:',
    ...open.map((t) => `  - ${t}`),
    'Finish them, or update the list to reflect reality, then say you are done.',
  ].join('\n');
}
