import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { openTodos } from '../src/core/state.ts';
import { ThreadStore } from '../src/core/store.ts';
import { Session } from '../src/loop/session.ts';
import type { ModelProvider } from '../src/model/provider.ts';
import { HeadlessSurface } from '../src/surfaces/headless.ts';
import { APPROVE_ALL, makeProject, makeSession, useTempHome } from './helpers.ts';

describe('the turn loop', () => {
  beforeEach(() => {
    useTempHome();
  });

  it('runs plan → approval → build and writes the file', async () => {
    const { session, store, cwd } = makeSession({ answers: APPROVE_ALL });
    const status = await session.run('summarise this directory');

    expect(status).toBe('completed');
    expect(store.current.mode).toBe('build');
    expect(existsSync(join(cwd, 'NOTES.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'NOTES.md'), 'utf8')).toContain('# NOTES');
  });

  it('seeds the todo list from the approved plan', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');

    expect(store.current.plan?.steps.length).toBeGreaterThan(0);
    expect(store.current.todos.length).toBe(store.current.plan?.steps.length);
    expect(store.current.todos.every((t) => t.status === 'completed')).toBe(true);
  });

  it('refuses to finish while todos are open, then lets the agent close them', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');

    const nudges = store.current.messages.filter((m) => m.role === 'user' && m.synthetic);
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges[0]?.text).toContain('task list still has open items');
    expect(openTodos(store.current)).toHaveLength(0);
  });

  it('gives up rather than nudging forever', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL, maxGateNudges: 0 });
    const status = await session.run('summarise this directory');

    expect(status).toBe('incomplete');
    expect(openTodos(store.current).length).toBeGreaterThan(0);
  });

  it('stays read-only until the plan is approved', async () => {
    const { session, store, cwd } = makeSession({
      answers: { plan: 'not yet — I want to see more of the repo first' },
      policy: 'deny',
    });
    await session.run('summarise this directory');

    expect(store.current.mode).toBe('plan');
    expect(existsSync(join(cwd, 'NOTES.md'))).toBe(false);
  });

  it('stops after a rejected plan instead of re-proposing forever', async () => {
    const { session, store } = makeSession({ answers: { plan: 'no' }, policy: 'deny' });
    await session.run('summarise this directory');

    const proposals = store.current.messages.filter((m) =>
      m.toolCalls?.some((c) => c.name === 'exit_plan_mode'),
    );
    // One proposal, one revision, then it asks instead of guessing again.
    expect(proposals).toHaveLength(2);
    expect(store.current.messages.at(-1)?.text).toContain('what should the plan be?');
    expect(store.current.mode).toBe('plan');
  });

  it('records a permission decision for every gated call', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');

    const write = store.current.decisions.find((d) => d.tool === 'write_file');
    expect(write).toBeDefined();
    expect(write?.resolution).toBe('approved_always');

    // "always" is persisted as a grant, so the next write would not ask at all.
    expect(store.current.grants.some((g) => g.tool === 'write_file')).toBe(true);
  });

  it('honours a hard deny of a tool for the whole session', async () => {
    const { session, store, cwd } = makeSession({
      answers: APPROVE_ALL,
      deniedTools: ['write_file'],
    });
    await session.run('summarise this directory');

    expect(existsSync(join(cwd, 'NOTES.md'))).toBe(false);
    const denied = store.current.decisions.find((d) => d.tool === 'write_file');
    expect(denied?.effect).toBe('deny');
    expect(denied?.rule).toBe('deny-rules');
  });

  it('runs an isolated subagent and bills its tokens to the thread', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');

    const sub = store.current.subagents[0];
    expect(sub?.kind).toBe('isolated');
    expect(sub?.report).toContain('Reviewed NOTES.md');
    expect(sub?.usage?.input).toBeGreaterThan(0);
  });

  it('delivers a message typed mid-run as steering, not as a new conversation', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL });

    const run = session.run('summarise this directory');
    setTimeout(() => session.enqueue('also mention the license'), 25);
    await run;

    const queued = store.current.messages.find((m) => m.text === 'also mention the license');
    expect(queued).toBeDefined();
    // It landed inside the same turn rather than starting another one…
    expect(store.current.messages.filter((m) => m.role === 'user' && !m.synthetic)).toHaveLength(2);
    // …and the agent folded it into the live task list.
    expect(store.current.todos.some((t) => t.text.includes('also mention the license'))).toBe(true);
  });

  it('breaks out when a model repeats the identical call', async () => {
    const stuck: ModelProvider = {
      name: 'stuck',
      async complete() {
        return {
          text: 'trying again',
          toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'README.md' } }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      },
    };

    const store = ThreadStore.create({ cwd: makeProject(), model: 'stuck' });
    const session = new Session({
      store,
      provider: stuck,
      surface: new HeadlessSurface({ policy: 'allow', out: () => {} }),
    });

    const status = await session.run('go');
    expect(status).toBe('incomplete');
    expect(store.current.messages.filter((m) => m.role === 'tool')).toHaveLength(3);
  });

  it('interrupts an in-flight turn and leaves the thread resumable', async () => {
    const { session, store } = makeSession({ answers: APPROVE_ALL });
    const run = session.run('summarise this directory');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.interrupt()).toBe(true);

    const status = await run;
    expect(status).toBe('interrupted');
    expect(store.current.lastTurn?.status).toBe('interrupted');
    expect(store.current.currentTurn).toBeNull();

    // The conversation is intact: a second turn continues from where it stopped.
    const second = await session.run('carry on');
    expect(second).toBe('completed');
    expect(store.current.mode).toBe('build');
  });
});
