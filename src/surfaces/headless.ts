import { readFileSync } from 'node:fs';

import type { Plan } from '../core/events.ts';
import { formatTrace } from '../perms/chain.ts';
import type { AskRequest, ConfirmAnswer, ConfirmRequest, PlanAnswer, Surface } from './types.ts';

export type AskPolicy = 'deny' | 'allow' | 'default';

export interface AnswerFile {
  /** Question text (or a substring of it) → the answer to give. */
  ask?: Record<string, string>;
  /** Tool name → 'approve' | 'approve_always' | 'reject'. */
  confirm?: Record<string, ConfirmAnswer>;
  /** 'approve' or a rejection reason. */
  plan?: string;
}

export interface HeadlessOptions {
  answers?: AnswerFile;
  policy?: AskPolicy;
  out?: (line: string) => void;
}

export function loadAnswers(path: string): AnswerFile {
  return JSON.parse(readFileSync(path, 'utf8')) as AnswerFile;
}

/**
 * The same pauses, rendered as text and resolved without a human.
 *
 * Nothing here blocks: a harness that hangs waiting for stdin in CI is worse
 * than one that refuses. Unanswered questions resolve by policy, and the default
 * policy is to refuse — loudly, in the transcript, where the log will show it.
 */
export class HeadlessSurface implements Surface {
  readonly kind = 'headless' as const;
  readonly canPrompt = false;

  private answers: AnswerFile;
  private policy: AskPolicy;
  private out: (line: string) => void;
  private unresolvedCount = 0;

  constructor(opts: HeadlessOptions = {}) {
    this.answers = opts.answers ?? {};
    this.policy = opts.policy ?? 'deny';
    this.out = opts.out ?? ((line) => process.stdout.write(`${line}\n`));
  }

  /**
   * How many pauses had to be settled by policy rather than by an answer, and
   * were settled as a refusal. CI should treat a run with any of these as failed:
   * the agent needed a human and there wasn't one.
   */
  get unresolved(): number {
    return this.unresolvedCount;
  }

  notify(line: string): void {
    this.out(line);
  }

  private block(title: string, body: string[]): void {
    this.out('');
    this.out(`=== ${title} ===`);
    for (const line of body) this.out(line);
    this.out('='.repeat(title.length + 8));
  }

  async ask(req: AskRequest): Promise<string> {
    const configured = matchAnswer(this.answers.ask ?? {}, req.question);
    const fallback =
      configured ??
      (this.policy === 'default' || this.policy === 'allow'
        ? (req.options?.[0] ?? 'yes')
        : null);

    this.block('HUMAN INPUT REQUIRED (ask_user)', [
      `Q: ${req.question}`,
      ...(req.context ? [`Context: ${req.context}`] : []),
      ...(req.options?.length ? [`Options: ${req.options.join(' | ')}`] : []),
      `Resolution: ${
        configured
          ? `answers file → "${configured}"`
          : fallback
            ? `--on-ask ${this.policy} → "${fallback}"`
            : `--on-ask deny → refusing to answer`
      }`,
    ]);

    if (!configured && !fallback) this.unresolvedCount += 1;

    return (
      fallback ??
      'No human is available in this environment and no answer was preconfigured. Proceed with your own best judgement and say which assumption you made.'
    );
  }

  async confirm(req: ConfirmRequest): Promise<ConfirmAnswer> {
    const configured = this.answers.confirm?.[req.tool];
    const answer: ConfirmAnswer =
      configured ?? (this.policy === 'allow' ? 'approve' : 'reject');
    if (!configured && answer === 'reject') this.unresolvedCount += 1;

    this.block('APPROVAL REQUIRED', [
      `Tool:    ${req.tool}`,
      `Subject: ${req.subject || '(none)'}`,
      `Chain:   ${req.decision.rule} → ${req.decision.effect} (${req.decision.reason})`,
      formatTrace(req.decision),
      `Resolution: ${configured ? 'answers file' : `--on-ask ${this.policy}`} → ${answer}`,
    ]);

    return answer;
  }

  async approvePlan(plan: Plan): Promise<PlanAnswer> {
    const configured = this.answers.plan;
    const approved = configured ? configured === 'approve' : this.policy !== 'deny';
    if (!configured && !approved) this.unresolvedCount += 1;

    this.block('PLAN APPROVAL REQUIRED', [
      plan.summary,
      ...plan.steps.map((s, i) => `  ${i + 1}. ${s.text}`),
      `Resolution: ${configured ? 'answers file' : `--on-ask ${this.policy}`} → ${approved ? 'approved' : 'rejected'}`,
    ]);

    return approved
      ? { approved: true }
      : {
          approved: false,
          reason:
            configured && configured !== 'approve'
              ? configured
              : 'no human available and --on-ask defaults to deny',
        };
  }
}

function matchAnswer(map: Record<string, string>, question: string): string | null {
  if (map[question]) return map[question];
  const key = Object.keys(map).find(
    (k) => question.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(question.toLowerCase()),
  );
  return key ? (map[key] ?? null) : null;
}
