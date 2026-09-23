import { ThreadLock, isStale } from './core/lock.ts';
import { ThreadStore } from './core/store.ts';
import { Session } from './loop/session.ts';
import { recoverIfCrashed } from './loop/recover.ts';
import { AnthropicProvider, DEFAULT_MODEL } from './model/anthropic.ts';
import type { ModelProvider } from './model/provider.ts';
import { ScriptedProvider } from './model/scripted.ts';
import { HeadlessSurface, loadAnswers, type AskPolicy } from './surfaces/headless.ts';
import { renderEvent } from './ui/render.ts';
import { runRepl } from './ui/repl.ts';
import { bold, dim } from './ui/terminal.ts';

interface Args {
  command: string;
  thread?: string;
  continue: boolean;
  model: string;
  yolo: boolean;
  deny: string[];
  headless: boolean;
  prompt?: string;
  answers?: string;
  onAsk: AskPolicy;
  cwd: string;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'chat',
    continue: false,
    model: 'scripted',
    yolo: false,
    deny: [],
    headless: !process.stdin.isTTY,
    onAsk: 'deny',
    cwd: process.cwd(),
    positional: [],
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-') && ['threads', 'replay', 'explain', 'chat', 'help'].includes(rest[0])) {
    args.command = rest.shift() as string;
  }

  while (rest.length) {
    const arg = rest.shift() as string;
    switch (arg) {
      case '--thread':
        args.thread = rest.shift();
        break;
      case '--continue':
      case '-c':
        args.continue = true;
        break;
      case '--model':
        args.model = rest.shift() ?? 'scripted';
        break;
      case '--yolo':
        args.yolo = true;
        break;
      case '--deny':
        args.deny.push(...(rest.shift() ?? '').split(',').filter(Boolean));
        break;
      case '--headless':
        args.headless = true;
        break;
      case '--prompt':
      case '-p':
        args.prompt = rest.shift();
        break;
      case '--answers':
        args.answers = rest.shift();
        break;
      case '--on-ask':
        args.onAsk = (rest.shift() ?? 'deny') as AskPolicy;
        break;
      case '--cwd':
        args.cwd = rest.shift() ?? process.cwd();
        break;
      case '--help':
      case '-h':
        args.command = 'help';
        break;
      default:
        args.positional.push(arg);
    }
  }

  return args;
}

function makeProvider(model: string): ModelProvider {
  if (model === 'scripted') return new ScriptedProvider();
  return new AnthropicProvider(model === 'anthropic' ? DEFAULT_MODEL : model);
}

function resolveStore(args: Args): ThreadStore {
  if (args.thread) return ThreadStore.open(args.thread);
  if (args.continue) {
    const latest = ThreadStore.latest();
    if (!latest) throw new Error('no threads yet — start one without --continue');
    return ThreadStore.open(latest);
  }
  return ThreadStore.create({ cwd: args.cwd, model: args.model });
}

const HELP = `
${bold('harness')} — a minimal agent harness

  harness [prompt]              start a new thread (interactive)
  harness -c                    resume the most recent thread
  harness --thread <id>         open a specific thread (a 2nd terminal follows it read-only)
  harness threads               list threads
  harness replay <id>           replay a thread's event log
  harness explain [--thread id] show what the approval chain decided, and why

Options
  --model scripted|anthropic|<model-id>   default: scripted (offline, deterministic)
  --yolo                                  skip approval prompts (rule 2 of the chain)
  --deny <tool,tool>                      hard-deny tools for this session (rule 1)
  --headless                              non-interactive; human pauses fall back to text
  -p, --prompt <text>                     the request to run (required with --headless)
  --answers <file.json>                   preanswered ask_user / approvals for headless runs
  --on-ask deny|allow|default             what headless does when nothing is preanswered
  --cwd <dir>                             working directory for the agent's tools
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (args.command === 'threads') {
    const threads = ThreadStore.list();
    if (!threads.length) {
      process.stdout.write('no threads yet\n');
      return;
    }
    for (const { id, updatedAt } of threads) {
      const state = ThreadStore.open(id).current;
      const lease = new ThreadLock(id).peek();
      const live = lease && !isStale(lease) ? ` ${bold('[open]')}` : '';
      process.stdout.write(
        `${id}  ${state.mode.padEnd(5)} ${String(state.messages.length).padStart(3)} msgs  ${updatedAt.toISOString()}${live}\n`,
      );
    }
    return;
  }

  if (args.command === 'replay') {
    const id = args.positional[0] ?? args.thread ?? ThreadStore.latest();
    if (!id) throw new Error('no thread to replay');
    for (const event of ThreadStore.open(id).readAll()) {
      const line = renderEvent(event);
      if (line) process.stdout.write(`${line}\n`);
    }
    return;
  }

  if (args.command === 'explain') {
    const id = args.thread ?? args.positional[0] ?? ThreadStore.latest();
    if (!id) throw new Error('no thread to explain');
    const state = ThreadStore.open(id).current;
    process.stdout.write(`${bold(`permission decisions on ${id}`)}\n`);
    if (!state.decisions.length) process.stdout.write(dim('  (none yet)\n'));
    for (const d of state.decisions) {
      const outcome = d.resolution ? `${d.effect}→${d.resolution}` : d.effect;
      process.stdout.write(
        `  #${String(d.seq).padStart(3)}  ${d.tool.padEnd(16)} ${outcome.padEnd(22)} ${dim(`decided by ${d.rule}: ${d.reason}`)}\n`,
      );
    }
    return;
  }

  const store = resolveStore(args);
  const provider = makeProvider(args.model);
  if (store.current.model !== provider.name) {
    store.append({ type: 'model_changed', from: store.current.model, to: provider.name });
  }

  const lock = new ThreadLock(store.id);
  const acquired = lock.acquire();

  // ------------------------------------------------------------------ headless
  if (args.headless) {
    if (!acquired.ok) {
      process.stderr.write(
        `thread ${store.id} is held by pid ${acquired.heldBy.pid}; refusing to write to it\n`,
      );
      process.exitCode = 1;
      return;
    }

    const prompt = args.prompt ?? args.positional.join(' ');
    if (!prompt) throw new Error('--headless needs -p "<prompt>"');

    recoverIfCrashed(store);
    const surface = new HeadlessSurface({
      answers: args.answers ? loadAnswers(args.answers) : undefined,
      policy: args.onAsk,
    });
    const session = new Session({
      store,
      provider,
      surface,
      yolo: args.yolo,
      deniedTools: args.deny,
    });

    const status = await session.run(prompt);
    lock.release();

    // A run that needed a human and did not get one is a failed run, even if the
    // agent shrugged and ended its turn politely.
    const refused = surface.unresolved;
    process.stdout.write(
      `\n[harness] turn ${status} · thread ${store.id}${refused ? ` · ${refused} pause(s) refused for lack of a human` : ''}\n`,
    );
    process.exitCode = status === 'completed' && refused === 0 ? 0 : 1;
    return;
  }

  // --------------------------------------------------------------- interactive
  await runRepl({
    store,
    provider,
    lock,
    follower: !acquired.ok,
    yolo: args.yolo,
    deniedTools: args.deny,
    firstPrompt: args.prompt ?? (args.positional.length ? args.positional.join(' ') : undefined),
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
