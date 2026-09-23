import { rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';

import { isStale, ThreadLock, type Lease } from '../src/core/lock.ts';
import { lockPath, threadDir } from '../src/core/paths.ts';
import { ThreadStore } from '../src/core/store.ts';
import { recoverIfCrashed } from '../src/loop/recover.ts';
import { APPROVE_ALL, makeProject, makeSession, useTempHome } from './helpers.ts';

describe('multi-surface coordination', () => {
  beforeEach(() => {
    useTempHome();
  });

  it('lets exactly one surface write to a thread', () => {
    const store = ThreadStore.create({ cwd: makeProject(), model: 'scripted' });

    const first = new ThreadLock(store.id);
    expect(first.acquire().ok).toBe(true);

    const second = new ThreadLock(store.id);
    const result = second.acquire();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.heldBy.pid).toBe(process.pid);

    first.release();
    expect(second.acquire().ok).toBe(true);
  });

  it('treats a lease from a dead process as available', () => {
    const store = ThreadStore.create({ cwd: makeProject(), model: 'scripted' });
    const dead: Lease = {
      surfaceId: 'srf_dead',
      pid: 999_999,
      host: hostname(),
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    writeFileSync(lockPath(store.id), JSON.stringify(dead), 'utf8');

    expect(isStale(dead)).toBe(true);
    const taken = new ThreadLock(store.id).acquire();
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.tookOver).toBe(true);
  });

  it('stops heart-beating instead of throwing when the thread is deleted', () => {
    const store = ThreadStore.create({ cwd: makeProject(), model: 'scripted' });
    const lock = new ThreadLock(store.id);
    expect(lock.acquire().ok).toBe(true);

    rmSync(threadDir(store.id), { recursive: true, force: true });

    expect(() => lock.beat()).not.toThrow();
    expect(lock.beat()).toBe(false);
    expect(lock.isHeld).toBe(false);
  });

  it('treats a stale heartbeat as available even if the pid is reused', () => {
    const lease: Lease = {
      surfaceId: 'srf_old',
      pid: process.pid,
      host: hostname(),
      acquiredAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 60_000,
    };
    expect(isStale(lease)).toBe(true);
  });

  it('a follower sees the writer\'s events by tailing the log', async () => {
    const { store: writer, session } = makeSession({ answers: APPROVE_ALL });

    // A second process opening the same thread id.
    const follower = ThreadStore.open(writer.id);
    const seen: string[] = [];
    follower.onEvent((event) => seen.push(event.type));

    await session.run('summarise this directory');

    expect(follower.current.seq).toBeLessThan(writer.current.seq);
    const fresh = follower.pull();
    expect(fresh.length).toBeGreaterThan(0);
    expect(seen).toContain('mode_changed');
    expect(follower.current.mode).toBe('build');
    expect(follower.current.todos).toEqual(writer.current.todos);
    expect(follower.current.tokens).toEqual(writer.current.tokens);
  });

  it('closes out a turn that was running when the process died', async () => {
    const { store, session } = makeSession({ answers: APPROVE_ALL });

    const run = session.run('summarise this directory');
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.interrupt();
    await run;

    // Fake a hard crash: a turn_started with no turn_ended.
    store.append({ type: 'turn_started', turnId: 'turn_crashed' });
    const reopened = ThreadStore.open(store.id);
    expect(reopened.current.currentTurn?.id).toBe('turn_crashed');

    const recovery = recoverIfCrashed(reopened);
    expect(recovery.crashed).toBe(true);
    expect(recovery.lastUserMessage).toBe('summarise this directory');
    expect(reopened.current.currentTurn).toBeNull();
    expect(reopened.current.lastTurn?.status).toBe('interrupted');
  });

  it('reports no recovery needed on a cleanly closed thread', async () => {
    const { store, session } = makeSession({ answers: APPROVE_ALL });
    await session.run('summarise this directory');
    expect(recoverIfCrashed(ThreadStore.open(store.id)).crashed).toBe(false);
  });
});
