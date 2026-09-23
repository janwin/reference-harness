import type { HarnessEvent } from '../core/events.ts';
import { bold, cyan, dim, green, red, yellow } from './terminal.ts';

/**
 * One event → one line of output. Shared by the follower surface and
 * `harness replay`, which is only possible because the log holds everything the
 * UI needs — the terminal is a view over state, not the owner of it.
 */
export function renderEvent(event: HarnessEvent): string | null {
  switch (event.type) {
    case 'user_message':
      return event.synthetic
        ? dim(event.text)
        : `${dim(event.source === 'queued' ? '› (queued)' : '›')} ${event.text}`;

    case 'assistant_message':
      return event.text.trim() ? `\n${event.text.trim()}` : null;

    case 'tool_result':
      return `  ${event.ok ? green('✓') : red('✗')} ${event.name} — ${firstLine(event.output)}`;

    case 'permission_decision': {
      if (event.effect === 'allow') return null;
      const verb =
        event.effect === 'deny'
          ? red('⛔ denied')
          : event.resolution === 'rejected'
            ? red('⛔ rejected by human')
            : green(`✓ approved${event.resolution === 'approved_always' ? ' (always)' : ''}`);
      return `  ${verb} ${bold(event.tool)} ${dim(`[${event.rule}] ${event.reason}`)}`;
    }

    case 'mode_changed':
      return cyan(`\n[harness] mode ${event.from} → ${event.to} (${event.reason})`);

    case 'model_changed':
      return cyan(`[harness] model ${event.from} → ${event.to}`);

    case 'todos_updated': {
      const done = event.todos.filter((t) => t.status === 'completed').length;
      return yellow(`[harness] task list: ${done}/${event.todos.length} complete`);
    }

    case 'memory_updated':
      return cyan(
        `[harness] memory ${event.settings.enabled ? `on, window ${event.settings.windowMessages}` : 'off'}`,
      );

    case 'grant_added':
      return green(`[harness] granted: ${event.grant.tool} @ ${event.grant.scope}`);

    case 'plan_proposed':
      return cyan(`[harness] plan proposed: ${event.plan.summary}`);

    case 'subagent_started':
      return dim(`  ↳ ${event.kind} subagent: ${firstLine(event.prompt)}`);

    case 'subagent_finished':
      return dim(`  ↳ subagent finished (${event.usage.input + event.usage.output} tokens)`);

    case 'turn_ended':
      return event.status === 'completed' ? null : dim(`[harness] turn ${event.status}`);

    case 'note':
      return dim(`[harness] ${event.text}`);

    default:
      return null;
  }
}

const firstLine = (text: string): string => {
  const line = text.split('\n')[0] ?? '';
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
};
