import { beforeEach, describe, expect, it } from 'vitest';

import { totalTokens } from '../src/core/events.ts';
import { ThreadStore } from '../src/core/store.ts';
import { initialState, replay } from '../src/core/state.ts';
import { APPROVE_ALL, makeSession, useTempHome } from './helpers.ts';

describe('thread persistence', () => {
  beforeEach(() => {
    useTempHome();
  });

  it('brings back mode, model, token count and memory settings after a reopen', async () => {
    const { store, session } = makeSession({ answers: APPROVE_ALL });
    session.setMemory({ enabled: true, windowMessages: 12, notes: ['prefers terse notes'] });
    await session.run('summarise this directory');

    const before = store.current;
    expect(before.mode).toBe('build');
    expect(totalTokens(before.tokens)).toBeGreaterThan(0);

    // Simulate closing the terminal and opening it again.
    const reopened = ThreadStore.open(store.id).current;

    expect(reopened.mode).toBe(before.mode);
    expect(reopened.model).toBe(before.model);
    expect(reopened.tokens).toEqual(before.tokens);
    expect(reopened.memory).toEqual({
      enabled: true,
      windowMessages: 12,
      notes: ['prefers terse notes'],
    });
    expect(reopened.todos).toEqual(before.todos);
    expect(reopened.messages.length).toBe(before.messages.length);
    expect(reopened.grants).toEqual(before.grants);
  });

  it('reaches the same state from a snapshot+tail as from a full replay', async () => {
    const { store, session } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');

    const viaSnapshot = ThreadStore.open(store.id).current;
    const viaFullReplay = replay(store.id, store.readAll(), initialState(store.id));

    expect(viaSnapshot).toEqual(viaFullReplay);
  });

  it('survives a torn final line in the log', async () => {
    const { store, session } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');
    const good = store.current.seq;

    const { appendFileSync } = await import('node:fs');
    const { eventLogPath } = await import('../src/core/paths.ts');
    appendFileSync(eventLogPath(store.id), '{"type":"user_message","text":"trunc');

    const reopened = ThreadStore.open(store.id).current;
    expect(reopened.seq).toBe(good);
  });

  it('lists threads newest first', async () => {
    const a = makeSession({ answers: APPROVE_ALL });
    await a.session.run('one');
    const b = makeSession({ answers: APPROVE_ALL });
    await b.session.run('two');

    const ids = ThreadStore.list().map((t) => t.id);
    expect(ids).toContain(a.store.id);
    expect(ids[0]).toBe(b.store.id);
  });
});
