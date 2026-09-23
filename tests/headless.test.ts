import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { HeadlessSurface } from '../src/surfaces/headless.ts';
import { evaluate } from '../src/perms/chain.ts';
import { makeSession, useTempHome } from './helpers.ts';

const decision = evaluate({
  tool: 'write_file',
  category: 'write',
  input: { path: 'NOTES.md', content: '' },
  mode: 'build',
  cwd: '/work',
  grants: [],
  yolo: false,
  deniedTools: [],
});

describe('headless human-pause fallback', () => {
  beforeEach(() => {
    useTempHome();
  });

  it('prints a plain-text block instead of a picker', async () => {
    const lines: string[] = [];
    const surface = new HeadlessSurface({ policy: 'default', out: (l) => lines.push(l) });

    await surface.ask({ question: 'Include a file tree?', options: ['yes', 'no'] });

    const text = lines.join('\n');
    expect(text).toContain('=== HUMAN INPUT REQUIRED (ask_user) ===');
    expect(text).toContain('Q: Include a file tree?');
    expect(text).toContain('Options: yes | no');
  });

  it('answers from the answers file when one matches', async () => {
    const surface = new HeadlessSurface({
      answers: { ask: { 'file tree': 'no, prose only' } },
      out: () => {},
    });
    expect(await surface.ask({ question: 'Should NOTES.md include a file tree?' })).toBe(
      'no, prose only',
    );
  });

  it('fails closed on approvals when nothing is preconfigured', async () => {
    const surface = new HeadlessSurface({ policy: 'deny', out: () => {} });
    expect(await surface.confirm({ tool: 'write_file', subject: '/work/NOTES.md', decision })).toBe(
      'reject',
    );
  });

  it('approves under --on-ask allow', async () => {
    const surface = new HeadlessSurface({ policy: 'allow', out: () => {} });
    expect(await surface.confirm({ tool: 'write_file', subject: '/work/NOTES.md', decision })).toBe(
      'approve',
    );
  });

  it('never blocks: an unanswerable question resolves with an explanation', async () => {
    const surface = new HeadlessSurface({ policy: 'deny', out: () => {} });
    const answer = await surface.ask({ question: 'What should I name it?' });
    expect(answer).toContain('No human is available');
  });

  it('runs the same agent end to end with no TTY', async () => {
    const { session, store, cwd } = makeSession({
      answers: {
        plan: 'approve',
        confirm: { write_file: 'approve' },
        ask: { 'file tree': 'Yes — include the tree' },
      },
      policy: 'deny',
    });

    const status = await session.run('summarise this directory');

    expect(status).toBe('completed');
    expect(store.current.mode).toBe('build');
    expect(existsSync(join(cwd, 'NOTES.md'))).toBe(true);
  });

  it('counts refused pauses so CI can fail the run', async () => {
    const surface = new HeadlessSurface({ policy: 'deny', out: () => {} });
    expect(surface.unresolved).toBe(0);

    await surface.ask({ question: 'unanswerable?' });
    await surface.confirm({ tool: 'write_file', subject: '/work/NOTES.md', decision });
    await surface.approvePlan({ summary: 's', steps: [{ text: 'one' }] });
    expect(surface.unresolved).toBe(3);

    // An autonomous run that policy *settles* is not a refusal.
    const autonomous = new HeadlessSurface({ policy: 'allow', out: () => {} });
    await autonomous.ask({ question: 'pick one', options: ['a', 'b'] });
    await autonomous.confirm({ tool: 'write_file', subject: '/work/NOTES.md', decision });
    await autonomous.approvePlan({ summary: 's', steps: [{ text: 'one' }] });
    expect(autonomous.unresolved).toBe(0);
  });

  it('refuses the write when CI has not preapproved it', async () => {
    const { session, store, cwd } = makeSession({
      answers: { plan: 'approve', ask: { 'file tree': 'No — prose only' } },
      policy: 'deny',
    });

    await session.run('summarise this directory');

    expect(existsSync(join(cwd, 'NOTES.md'))).toBe(false);
    const rejected = store.current.decisions.find((d) => d.tool === 'write_file');
    expect(rejected?.resolution).toBe('rejected');
  });
});
