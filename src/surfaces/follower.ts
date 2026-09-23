import type { Plan } from '../core/events.ts';
import type { Terminal } from '../ui/terminal.ts';
import type { AskRequest, ConfirmAnswer, ConfirmRequest, PlanAnswer, Surface } from './types.ts';

const REFUSAL =
  'this surface is following the thread read-only; the terminal that owns the lease answers prompts';

/**
 * A second terminal on the same thread. It renders everything and decides
 * nothing — which is the only safe answer to "two surfaces, one conversation".
 */
export class FollowerSurface implements Surface {
  readonly kind = 'follower' as const;
  readonly canPrompt = false;

  constructor(private terminal: Terminal) {}

  notify(line: string): void {
    this.terminal.write(line);
  }

  async ask(_req: AskRequest): Promise<string> {
    throw new Error(`ask_user: ${REFUSAL}`);
  }

  async confirm(_req: ConfirmRequest): Promise<ConfirmAnswer> {
    return 'reject';
  }

  async approvePlan(_plan: Plan): Promise<PlanAnswer> {
    return { approved: false, reason: REFUSAL };
  }
}
