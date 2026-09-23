import type { Todo, TodoStatus } from '../core/events.ts';
import { fail, ok, type Tool } from './types.ts';

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * The todo list lives in thread state, not in the model's head — which is why it
 * survives a restart, renders live in every surface, and can be used by the
 * harness to refuse a premature "done".
 */
export const todoWrite: Tool = {
  name: 'todo_write',
  category: 'meta',
  description:
    'Replace your task list. Write it before starting multi-step work, and update statuses as you go. The harness will not let you finish while items are open.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(input, ctx) {
    const raw = Array.isArray(input.todos) ? input.todos : null;
    if (!raw) return fail('todo_write requires a `todos` array');

    const todos: Todo[] = raw.map((entry, index) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const status = String(item.status ?? 'pending') as TodoStatus;
      return {
        id: String(item.id ?? `t${index + 1}`),
        text: String(item.text ?? '').trim(),
        status: STATUSES.includes(status) ? status : 'pending',
      };
    });

    ctx.session.setTodos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return ok(`Task list updated: ${done}/${todos.length} complete.`);
  },
};
