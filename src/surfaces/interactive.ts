import type { Plan } from '../core/events.ts';
import { formatTrace } from '../perms/chain.ts';
import { bold, cyan, dim, ESC, Terminal, yellow } from '../ui/terminal.ts';
import type { AskRequest, ConfirmAnswer, ConfirmRequest, PlanAnswer, Surface } from './types.ts';

/**
 * The human-facing surface. Its only job is to turn a suspended promise into a
 * keystroke — the loop does not know or care that a terminal exists.
 */
export class InteractiveSurface implements Surface {
  readonly kind = 'interactive' as const;
  readonly canPrompt = true;

  constructor(private terminal: Terminal) {}

  notify(line: string): void {
    this.terminal.write(line);
  }

  async ask(req: AskRequest): Promise<string> {
    const options = req.options ?? [];
    this.terminal.writeBare(
      [
        '',
        yellow('┌─ the agent is asking you ─────────────'),
        `│ ${bold(req.question)}`,
        ...(req.context ? [dim(`│ ${req.context}`)] : []),
        ...options.map((opt, i) => `│   ${i + 1}) ${opt}`),
        dim(options.length ? '│ pick a number, or type your own answer' : '│ type your answer'),
        yellow('└───────────────────────────────────────'),
      ].join('\n'),
    );

    const answer = await this.readLine('answer › ');
    const index = Number(answer.trim()) - 1;
    if (options.length && Number.isInteger(index) && options[index]) return options[index];
    return answer.trim() || '(no answer)';
  }

  async confirm(req: ConfirmRequest): Promise<ConfirmAnswer> {
    this.terminal.writeBare(
      [
        '',
        yellow('┌─ approval needed ─────────────────────'),
        `│ ${bold(req.tool)} ${req.subject ? dim(req.subject) : ''}`,
        ...(req.preview
          ? req.preview.split('\n').map((l) => dim(`│   ${l}`))
          : []),
        dim('│ chain:'),
        ...formatTrace(req.decision).split('\n').map((l) => dim(`│ ${l}`)),
        '│ [y] once   [a] always (remembered on this thread)   [n] reject',
        yellow('└───────────────────────────────────────'),
      ].join('\n'),
    );

    const key = await this.readKey('approve? ');
    if (key === 'a') return 'approve_always';
    if (key === 'y') return 'approve';
    return 'reject';
  }

  async approvePlan(plan: Plan): Promise<PlanAnswer> {
    this.terminal.writeBare(
      [
        '',
        cyan('┌─ plan for approval ───────────────────'),
        `│ ${bold(plan.summary)}`,
        ...plan.steps.map((s, i) => `│   ${i + 1}. ${s.text}`),
        dim('│ approving switches this thread from read-only PLAN to BUILD'),
        '│ [y] approve   [n] reject (say why)',
        cyan('└───────────────────────────────────────'),
      ].join('\n'),
    );

    const key = await this.readKey('approve plan? ');
    if (key === 'y') return { approved: true };
    const reason = await this.readLine('what should change? › ');
    return { approved: false, reason };
  }

  /** Borrow stdin from the line editor for the duration of one prompt. */
  private readKey(label: string): Promise<string> {
    this.terminal.pauseInput();
    process.stdout.write(dim(label));
    return new Promise((resolve) => {
      const off = this.terminal.onRawData((chunk: string) => {
        const key = chunk.toString().toLowerCase();
        off();
        this.terminal.resumeInput();
        process.stdout.write(`${key === ESC ? 'esc' : key.trim()}\n`);
        resolve(key === ESC ? 'n' : key.trim().slice(0, 1));
      });
    });
  }

  private readLine(label: string): Promise<string> {
    this.terminal.pauseInput();
    process.stdout.write(dim(label));
    let buffer = '';
    return new Promise((resolve) => {
      const off = this.terminal.onRawData((chunk: string) => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') {
            off();
            this.terminal.resumeInput();
            process.stdout.write('\n');
            resolve(buffer);
            return;
          }
          if (char === '\x7f') {
            buffer = buffer.slice(0, -1);
            process.stdout.write('\b \b');
            continue;
          }
          if (char === '\x03') {
            off();
            this.terminal.resumeInput();
            resolve('');
            return;
          }
          if (char >= ' ') {
            buffer += char;
            process.stdout.write(char);
          }
        }
      });
    });
  }
}
