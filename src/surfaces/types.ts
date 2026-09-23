import type { Plan } from '../core/events.ts';
import type { ChainResult } from '../perms/chain.ts';

export interface AskRequest {
  question: string;
  options?: string[];
  context?: string;
}

export interface ConfirmRequest {
  tool: string;
  subject: string;
  preview?: string;
  decision: ChainResult;
}

export type ConfirmAnswer = 'approve' | 'approve_always' | 'reject';

export type PlanAnswer = { approved: true } | { approved: false; reason: string };

/**
 * Everything the loop needs from "the outside world". Swapping this is what lets
 * the identical agent run in a terminal, in CI, or as a read-only follower.
 */
export interface Surface {
  readonly kind: 'interactive' | 'headless' | 'follower';
  /** Can this surface actually reach a human? Headless CI cannot. */
  readonly canPrompt: boolean;

  notify(line: string): void;
  ask(req: AskRequest): Promise<string>;
  confirm(req: ConfirmRequest): Promise<ConfirmAnswer>;
  approvePlan(plan: Plan): Promise<PlanAnswer>;
  close?(): void;
}
