/**
 * A guided tour of every harness capability, start to finish, with no API key.
 *
 *   npm run demo
 *
 * Everything here runs the real harness — the same Session, the same approval
 * chain, the same event log the interactive CLI uses. Only the surface differs.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'harness-demo-home-'));
process.env.HARNESS_HOME = home;

const { ThreadStore } = await import('../src/core/store.ts');
const { ThreadLock, isStale } = await import('../src/core/lock.ts');
const { Session } = await import('../src/loop/session.ts');
const { recoverIfCrashed } = await import('../src/loop/recover.ts');
const { ScriptedProvider } = await import('../src/model/scripted.ts');
const { HeadlessSurface } = await import('../src/surfaces/headless.ts');
const { evaluate, formatTrace } = await import('../src/perms/chain.ts');
const { totalTokens } = await import('../src/core/events.ts');
const { bold, cyan, dim, green, red, yellow } = await import('../src/ui/terminal.ts');

const project = mkdtempSync(join(tmpdir(), 'harness-demo-project-'));
writeFileSync(join(project, 'README.md'), '# Demo project\n\nThree files and a dream.\n');
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2));
writeFileSync(join(project, 'main.ts'), 'console.log("hello");\n');

let step = 0;
function heading(title: string, why: string): void {
  step += 1;
  console.log(`\n${bold(`━━ ${step}. ${title} `.padEnd(72, '━'))}`);
  console.log(dim(`   ${why}\n`));
}

const quiet = { out: () => {} };

function newSession(opts: Parameters<typeof makeSurface>[0] & { yolo?: boolean } = {}) {
  const store = ThreadStore.create({ cwd: project, model: 'scripted' });
  const session = new Session({
    store,
    provider: new ScriptedProvider(),
    surface: makeSurface(opts),
    yolo: opts.yolo,
  });
  return { store, session };
}

function makeSurface(opts: { answers?: any; policy?: any; loud?: boolean }) {
  return new HeadlessSurface({
    answers: opts.answers,
    policy: opts.policy ?? 'allow',
    ...(opts.loud ? {} : quiet),
  });
}

const APPROVE = {
  plan: 'approve',
  confirm: { write_file: 'approve_always' as const },
  ask: { 'file tree': 'Yes — include the tree' },
};

// ─────────────────────────────────────────────────────────────── 1. plan → build
heading(
  'Plan → build handoff, live task list, and the completion gate',
  'One approval flips a read-only thread into an executing one and seeds the todos.',
);

const main = newSession({ answers: APPROVE, loud: true });
console.log(dim(`   thread ${main.store.id} · cwd ${project}\n`));
await main.session.run('Summarise this directory and write NOTES.md');

console.log(`\n   ${bold('final task list')}`);
for (const todo of main.store.current.todos) {
  console.log(`     ${todo.status === 'completed' ? green('●') : yellow('○')} ${todo.text}`);
}
console.log(
  `\n   NOTES.md written: ${existsSync(join(project, 'NOTES.md')) ? green('yes') : red('no')}`,
);
const nudges = main.store.current.messages.filter((m) => m.role === 'user' && m.synthetic);
console.log(
  `   the agent tried to finish early ${bold(String(nudges.length))} time(s); the gate sent it back.`,
);

// ──────────────────────────────────────────────────────────── 2. thread persistence
heading(
  'Thread persistence',
  'Close the terminal mid-task, reopen: same mode, model, token count, memory, todos.',
);

const before = main.store.current;
const reopened = ThreadStore.open(main.store.id).current;
const row = (label: string, a: unknown, b: unknown): string =>
  `   ${label.padEnd(10)} ${String(a).padEnd(28)} ${String(b).padEnd(28)} ${a === b ? green('same') : red('DIFFERENT')}`;
console.log(`   ${'field'.padEnd(10)} ${'before close'.padEnd(28)} ${'after reopen'.padEnd(28)}`);
console.log(row('mode', before.mode, reopened.mode));
console.log(row('model', before.model, reopened.model));
console.log(row('tokens', totalTokens(before.tokens), totalTokens(reopened.tokens)));
console.log(row('memory', JSON.stringify(before.memory), JSON.stringify(reopened.memory)));
console.log(row('todos', before.todos.length, reopened.todos.length));
console.log(row('messages', before.messages.length, reopened.messages.length));
console.log(row('grants', before.grants.length, reopened.grants.length));
console.log(dim(`\n   ${before.seq} events on disk at ${home}/threads/${main.store.id}/`));

// ─────────────────────────────────────────────────────────────── 3. approval chain
heading(
  'The approval chain',
  'An ordered rule list decides every tool call, and records which rule decided it.',
);

const probes: Array<[string, Parameters<typeof evaluate>[0]]> = [
  ['read a file', reqFor('read_file', 'read', { path: 'README.md' }, {})],
  ['write in build mode', reqFor('write_file', 'write', { path: 'NOTES.md' }, {})],
  ['write in plan mode', reqFor('write_file', 'write', { path: 'NOTES.md' }, { mode: 'plan' })],
  ['write in plan mode, --yolo', reqFor('write_file', 'write', { path: 'NOTES.md' }, { mode: 'plan', yolo: true })],
  ['write with a standing grant', reqFor('write_file', 'write', { path: 'NOTES.md' }, { grants: [{ tool: 'write_file', scope: project, grantedAt: 'earlier' }] })],
  ['write into .git, --yolo', reqFor('write_file', 'write', { path: '.git/config' }, { yolo: true })],
  ['rm -rf, --yolo', reqFor('run_command', 'exec', { command: 'rm -rf /' }, { yolo: true })],
];

for (const [label, req] of probes) {
  const result = evaluate(req);
  const colour = result.effect === 'allow' ? green : result.effect === 'deny' ? red : yellow;
  console.log(`   ${label.padEnd(30)} ${colour(result.effect.toUpperCase().padEnd(6))} ${dim(`← ${result.rule}: ${result.reason}`)}`);
}

console.log(`\n   ${dim('full trace for "write in plan mode, --yolo":')}`);
console.log(formatTrace(evaluate(probes[3]![1])));

console.log(`\n   ${bold('what actually happened on the live thread:')}`);
for (const d of main.store.current.decisions) {
  if (d.effect === 'allow' && d.rule === 'category-policy') continue;
  const outcome = d.resolution ? `${d.effect}→${d.resolution}` : d.effect;
  console.log(`     #${String(d.seq).padStart(3)} ${d.tool.padEnd(16)} ${outcome.padEnd(22)} ${dim(`[${d.rule}]`)}`);
}

// ─────────────────────────────────────────────────────────── 4. headless fallback
heading(
  'Tools that pause for humans — with a plain-text fallback',
  'The same agent, no TTY. Questions print as text and resolve by policy, never hang.',
);

const ci = newSession({ policy: 'deny', loud: true });
const ciStatus = await ci.session.run('Summarise this directory and write NOTES.md');
console.log(
  `\n   turn ended ${bold(ciStatus)} — with --on-ask deny, CI refuses rather than guessing.`,
);
console.log(dim('   (pass --answers answers.json to preapprove specific questions instead)'));

// ───────────────────────────────────────────────────────────── 5. interrupt / steer
heading(
  'Interrupt, queue, steer',
  'The conversation is an open channel: type over a running task, or abort and redirect.',
);

const steered = newSession({ answers: APPROVE });
const run = steered.session.run('Summarise this directory and write NOTES.md');
setTimeout(() => {
  console.log(dim('   [human types mid-run] "also mention the license"'));
  steered.session.enqueue('also mention the license');
}, 40);
await run;
console.log(
  `   folded into the live task list: ${
    steered.store.current.todos.some((t) => t.text.includes('license')) ? green('yes') : red('no')
  }`,
);
console.log(
  dim(
    `   one turn, ${steered.store.current.messages.filter((m) => m.role === 'user' && !m.synthetic).length} human messages — steering, not a second conversation`,
  ),
);

const aborted = newSession({ answers: APPROVE });
const abortRun = aborted.session.run('Summarise this directory and write NOTES.md');
setTimeout(() => {
  console.log(dim('   [human presses Esc]'));
  aborted.session.interrupt();
}, 40);
console.log(`   turn ended: ${bold(await abortRun)} — thread kept, ready to be redirected`);

// ───────────────────────────────────────────────────────────────── 6. subagents
heading(
  'Subagents',
  'Isolated for an unbiased review; forked to reuse the parent prefix and keep the cache warm.',
);

for (const sub of main.store.current.subagents) {
  console.log(`   ${bold(sub.kind)} — ${dim(sub.prompt)}`);
  for (const line of (sub.report ?? '').split('\n')) console.log(`     ${line}`);
  console.log(dim(`     cost: ${totalTokens(sub.usage!)} tokens, ${sub.usage!.cacheRead} from cache`));
}

const forked = await main.session.runSubagent({
  kind: 'fork',
  prompt: 'Using the context you already have, re-check NOTES.md.',
  signal: new AbortController().signal,
});
console.log(`   ${bold('fork')} — inherits the parent transcript`);
console.log(dim(`     cost: ${totalTokens(forked.usage)} tokens (a real provider bills the shared prefix as cache_read)`));

// ─────────────────────────────────────────────── 7. crash recovery / multi-surface
heading(
  'Crash recovery and two terminals on one thread',
  'One writer holds a heartbeat lease; everyone else follows the log read-only.',
);

const writerLock = new ThreadLock(main.store.id);
console.log(`   terminal A acquires the lease: ${writerLock.acquire().ok ? green('ok') : red('refused')}`);

const secondLock = new ThreadLock(main.store.id);
const second = secondLock.acquire();
console.log(
  `   terminal B tries to write:            ${second.ok ? green('ok') : red(`refused — held by pid ${second.heldBy.pid}`)}`,
);

const follower = ThreadStore.open(main.store.id);
console.log(dim(`   terminal B opens as a follower at seq ${follower.current.seq}`));
main.store.append({ type: 'note', text: 'terminal A is still working' });
await main.session.run('one more look');
const fresh = follower.pull();
console.log(
  `   terminal B tailed ${bold(String(fresh.length))} new events without touching the lock; both now at seq ${follower.current.seq}`,
);

writerLock.release();
console.log(`   terminal A exits; lease stale: ${isStale(secondLock.peek() ?? { surfaceId: '', pid: 0, host: '', acquiredAt: 0, heartbeatAt: 0 }) ? green('yes → B can take over') : red('no')}`);

main.store.append({ type: 'turn_started', turnId: 'turn_killed' });
console.log(dim('\n   [simulating kill -9 mid-turn]'));
const crashed = ThreadStore.open(main.store.id);
const recovery = recoverIfCrashed(crashed);
console.log(
  `   reopened: crash detected ${recovery.crashed ? green('yes') : red('no')}, turn closed as ${bold(crashed.current.lastTurn!.status)}`,
);
console.log(dim(`   last request preserved: "${recovery.lastUserMessage}"`));

// ────────────────────────────────────────────────────────────────────── epilogue
console.log(`\n${bold('━'.repeat(72))}`);
console.log(`
${bold('What the agent did:')} read three files and wrote a NOTES.md.
${bold('What the harness did:')} kept the thread on disk, gated every side effect
through an ordered rule chain, paused for a human twice, flipped the thread from
read-only to executing on approval, refused a premature "done", absorbed a
mid-run steer, ran a subagent, and recovered a killed turn.

${dim(`thread log:   ${home}/threads/${main.store.id}/events.jsonl`)}
${dim(`demo project: ${project}`)}
${dim(`NOTES.md:     ${readFileSync(join(project, 'NOTES.md'), 'utf8').split('\n').length} lines`)}

Try it interactively:   ${cyan(`npm run harness -- --cwd ${project}`)}
Inspect the decisions:  ${cyan(`HARNESS_HOME=${home} npm run harness -- explain --thread ${main.store.id}`)}
Replay the whole thread:${cyan(` HARNESS_HOME=${home} npm run harness -- replay ${main.store.id}`)}
`);

function reqFor(
  tool: string,
  category: any,
  input: Record<string, unknown>,
  over: Record<string, unknown>,
): any {
  return {
    tool,
    category,
    input,
    mode: 'build',
    cwd: project,
    grants: [],
    yolo: false,
    deniedTools: [],
    ...over,
  };
}
