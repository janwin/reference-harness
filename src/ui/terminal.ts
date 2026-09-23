import { totalTokens } from '../core/events.ts';
import type { ThreadState } from '../core/state.ts';

export const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const BACKSPACE = '\x7f';

export const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
export const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
export const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

export interface KeyHandlers {
  onLine(line: string): void;
  onEscape(): void;
  onInterruptSignal(): void;
}

/**
 * A very small raw-mode terminal: a one-line editor pinned to the bottom, a
 * status line above it, and scrolling output above that.
 *
 * Raw mode is the whole trick. With readline you cannot accept input while a
 * task runs, and "type over a running task" is exactly what a conversation with
 * an agent needs to support.
 */
export class Terminal {
  private buffer = '';
  private footerLines = 0;
  private handlers: KeyHandlers | null = null;
  private status = '';
  private prompt = '› ';
  private paused = false;

  start(handlers: KeyHandlers): void {
    this.handlers = handlers;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this.onData);
  }

  stop(): void {
    process.stdin.off('data', this.onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.clearFooter();
  }

  /** Hand keystrokes to a prompt instead of the line editor. */
  pauseInput(): void {
    this.paused = true;
  }

  resumeInput(): void {
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  onRawData(listener: (chunk: string) => void): () => void {
    process.stdin.on('data', listener as (chunk: unknown) => void);
    return () => process.stdin.off('data', listener as (chunk: unknown) => void);
  }

  private onData = (chunk: string): void => {
    if (this.paused || !this.handlers) return;

    if (chunk === CTRL_C || chunk === CTRL_D) {
      this.handlers.onInterruptSignal();
      return;
    }
    if (chunk === ESC) {
      this.handlers.onEscape();
      return;
    }
    if (chunk.startsWith(ESC)) return; // arrow keys and friends: ignored

    for (const char of chunk) {
      if (char === '\r' || char === '\n') {
        const line = this.buffer;
        this.buffer = '';
        this.render();
        this.handlers.onLine(line);
        continue;
      }
      if (char === BACKSPACE) {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }
      if (char >= ' ') this.buffer += char;
    }
    this.render();
  };

  setStatus(status: string): void {
    this.status = status;
    this.render();
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
    this.render();
  }

  /** Print above the footer without disturbing what the human is typing. */
  write(text: string): void {
    this.clearFooter();
    process.stdout.write(`${text}\n`);
    this.render();
  }

  /** Write with the footer torn down, for prompts that draw their own UI. */
  writeBare(text: string): void {
    this.clearFooter();
    process.stdout.write(`${text}\n`);
  }

  private clearFooter(): void {
    if (this.footerLines === 0) return;
    process.stdout.write('\r\x1b[2K');
    for (let i = 1; i < this.footerLines; i += 1) {
      process.stdout.write('\x1b[1A\r\x1b[2K');
    }
    this.footerLines = 0;
  }

  render(): void {
    this.clearFooter();
    const lines = [this.status, `${this.prompt}${this.buffer}`].filter((l) => l !== '');
    process.stdout.write(lines.join('\n'));
    this.footerLines = lines.length;
  }
}

export function statusLine(
  state: ThreadState,
  extra: { running: boolean; queued: number; follower?: boolean },
): string {
  const done = state.todos.filter((t) => t.status === 'completed').length;
  const parts = [
    dim(`thread:${state.id}`),
    state.mode === 'plan' ? cyan('mode:plan') : green('mode:build'),
    dim(`model:${state.model}`),
    dim(`tokens:${fmt(totalTokens(state.tokens))}`),
    dim(`mem:${state.memory.enabled ? `${state.memory.windowMessages}msg` : 'off'}`),
  ];
  if (state.todos.length) parts.push(yellow(`todos:${done}/${state.todos.length}`));
  if (extra.queued) parts.push(yellow(`queued:${extra.queued}`));
  if (extra.follower) parts.push(red('FOLLOWER (read-only)'));
  if (extra.running) parts.push(green('running — type to queue, Esc to interrupt'));
  return parts.join(dim(' · '));
}

export function todoPanel(state: ThreadState): string {
  if (!state.todos.length) return '';
  const glyph = { pending: '○', in_progress: '◐', completed: '●' } as const;
  return [
    dim('  ── tasks ─────────────'),
    ...state.todos.map((t) => {
      const line = `  ${glyph[t.status]} ${t.text}`;
      return t.status === 'completed' ? dim(line) : t.status === 'in_progress' ? yellow(line) : line;
    }),
    dim('  ──────────────────────'),
  ].join('\n');
}

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
