import { isStale, ThreadLock } from '../core/lock.ts';
import type { ThreadStore } from '../core/store.ts';
import { Session } from '../loop/session.ts';
import { recoverIfCrashed } from '../loop/recover.ts';
import type { ModelProvider } from '../model/provider.ts';
import { FollowerSurface } from '../surfaces/follower.ts';
import { InteractiveSurface } from '../surfaces/interactive.ts';
import { renderEvent } from './render.ts';
import { bold, dim, green, red, statusLine, Terminal, todoPanel, yellow } from './terminal.ts';

export interface ReplOptions {
  store: ThreadStore;
  provider: ModelProvider;
  lock: ThreadLock;
  follower: boolean;
  yolo: boolean;
  deniedTools: string[];
  firstPrompt?: string;
}

const DOUBLE_ESC_MS = 800;

export async function runRepl(opts: ReplOptions): Promise<void> {
  const terminal = new Terminal();
  const { store } = opts;

  const surface = opts.follower ? new FollowerSurface(terminal) : new InteractiveSurface(terminal);
  const session = opts.follower
    ? null
    : new Session({
        store,
        provider: opts.provider,
        surface,
        yolo: opts.yolo,
        deniedTools: opts.deniedTools,
      });

  let lastEscape = 0;
  let running = false;
  let closed = false;

  const refresh = (): void => {
    terminal.setStatus(
      statusLine(store.current, {
        running,
        queued: session?.queued.length ?? 0,
        follower: opts.follower,
      }),
    );
  };

  store.onEvent((event) => {
    if (event.type === 'todos_updated') terminal.write(todoPanel(store.current));
    refresh();
  });

  terminal.start({
    onLine: (line) => void handleLine(line),
    onEscape: () => handleEscape(),
    onInterruptSignal: () => shutdown(0),
  });

  banner();

  if (opts.follower) {
    startFollowing();
  } else {
    const recovery = recoverIfCrashed(store);
    if (recovery.crashed) {
      terminal.write(
        yellow(
          `[harness] this thread had a turn still running when it last exited — closed it as interrupted.`,
        ),
      );
      if (recovery.lastUserMessage) {
        terminal.write(dim(`[harness] last request was: "${recovery.lastUserMessage}"`));
        terminal.write(dim('[harness] type /resume to run it again, or just say something else.'));
      }
    }
  }

  refresh();

  if (opts.firstPrompt && session) await handleLine(opts.firstPrompt);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      shutdown(0);
      resolve();
    });
    process.on('exit', () => resolve());
  });

  // ------------------------------------------------------------------ handlers

  async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) {
      refresh();
      return;
    }

    if (opts.follower) {
      if (text === '/takeover') return void takeover();
      terminal.write(dim('[harness] read-only follower. /takeover to claim the thread, /quit to exit.'));
      return;
    }

    if (text.startsWith('/')) return void handleCommand(text);

    if (running) {
      // Typing over a running task does not start a second conversation.
      session?.enqueue(text);
      terminal.write(dim(`[harness] queued — will be delivered at the next step (${session?.queued.length})`));
      refresh();
      return;
    }

    running = true;
    refresh();
    try {
      await session?.run(text);
    } finally {
      running = false;
      refresh();
    }
  }

  function handleEscape(): void {
    if (!running || !session) return;
    const now = Date.now();
    const isDouble = now - lastEscape < DOUBLE_ESC_MS;
    lastEscape = now;

    if (isDouble && session.queued.length) {
      session.clearQueue();
      terminal.write(red('[harness] queue discarded'));
    }
    if (session.interrupt()) {
      terminal.write(red('[harness] aborting…'));
    }
    refresh();
  }

  async function handleCommand(text: string): Promise<void> {
    const [command, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');

    switch (command) {
      case 'quit':
      case 'exit':
        shutdown(0);
        return;

      case 'help':
        banner();
        return;

      case 'todos':
        terminal.write(todoPanel(store.current) || dim('(no tasks)'));
        return;

      case 'mode': {
        if (arg !== 'plan' && arg !== 'build') {
          terminal.write(dim(`mode is ${store.current.mode}; use /mode plan|build`));
          return;
        }
        session?.switchMode(arg, 'set by the human');
        refresh();
        return;
      }

      case 'memory': {
        if (arg === 'off') session?.setMemory({ enabled: false });
        else if (arg === 'on') session?.setMemory({ enabled: true });
        else if (/^\d+$/.test(arg)) session?.setMemory({ enabled: true, windowMessages: Number(arg) });
        else if (arg.startsWith('note ')) {
          const note = arg.slice(5);
          session?.setMemory({ notes: [...store.current.memory.notes, note] });
        } else {
          terminal.write(dim('usage: /memory on|off|<window-size>|note <text>'));
          return;
        }
        terminal.write(green(`[harness] memory: ${JSON.stringify(store.current.memory)}`));
        return;
      }

      case 'grants': {
        const { grants } = store.current;
        terminal.write(
          grants.length
            ? grants.map((g) => `  ${g.tool} @ ${g.scope} (${g.grantedAt})`).join('\n')
            : dim('(no standing grants — every write will ask)'),
        );
        return;
      }

      case 'explain': {
        const decisions = store.current.decisions.slice(-12);
        terminal.write(
          decisions.length
            ? decisions
                .map(
                  (d) =>
                    `  #${d.seq} ${bold(d.tool)} → ${d.effect}${d.resolution ? `/${d.resolution}` : ''} ${dim(`[${d.rule}] ${d.reason}`)}`,
                )
                .join('\n')
            : dim('(no permission decisions yet)'),
        );
        return;
      }

      case 'resume': {
        const last = [...store.current.messages]
          .reverse()
          .find((m) => m.role === 'user' && !m.synthetic);
        if (!last) {
          terminal.write(dim('(nothing to resume)'));
          return;
        }
        terminal.write(dim(`[harness] resuming: ${last.text}`));
        await handleLine(last.text);
        return;
      }

      case 'thread':
        terminal.write(
          [
            `  id:      ${store.current.id}`,
            `  cwd:     ${store.current.cwd}`,
            `  mode:    ${store.current.mode}`,
            `  model:   ${store.current.model}`,
            `  tokens:  ${JSON.stringify(store.current.tokens)}`,
            `  memory:  ${JSON.stringify(store.current.memory)}`,
            `  events:  ${store.current.seq}`,
          ].join('\n'),
        );
        return;

      default:
        terminal.write(dim(`unknown command /${command} — try /help`));
    }
  }

  // ----------------------------------------------------------------- following

  function startFollowing(): void {
    terminal.write(
      yellow(
        `[harness] following thread ${store.current.id} read-only — another surface owns the lease`,
      ),
    );
    const timer = setInterval(() => {
      for (const event of store.pull()) {
        const line = renderEvent(event);
        if (line) terminal.write(line);
      }
      const lease = opts.lock.peek();
      if (!lease || isStale(lease)) {
        terminal.write(
          green('[harness] the writing surface is gone — /takeover to claim this thread'),
        );
        clearInterval(timer);
      }
      refresh();
    }, 400);
    timer.unref?.();
  }

  function takeover(): void {
    const lease = opts.lock.peek();
    if (lease && !isStale(lease)) {
      terminal.write(
        red(`[harness] refusing: pid ${lease.pid} is alive and heartbeating. Close it first.`),
      );
      return;
    }
    terminal.write(green('[harness] taking over — restart with the same --thread to write.'));
    opts.lock.acquire({ force: true });
  }

  function banner(): void {
    terminal.write(
      [
        '',
        bold('harness-mvp') + dim(' — the agent is the boring part'),
        dim('  type to talk · type while running to queue · Esc to interrupt · Esc Esc to drop the queue'),
        dim('  /mode plan|build  /todos  /explain  /grants  /memory  /thread  /resume  /quit'),
        '',
      ].join('\n'),
    );
  }

  function shutdown(code: number): void {
    if (closed) return;
    closed = true;
    session?.interrupt();
    opts.lock.release();
    terminal.stop();
    process.stdout.write('\n');
    process.exit(code);
  }
}
