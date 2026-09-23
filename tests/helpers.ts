import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ThreadStore } from '../src/core/store.ts';
import { Session } from '../src/loop/session.ts';
import { ScriptedProvider } from '../src/model/scripted.ts';
import { HeadlessSurface, type AnswerFile, type AskPolicy } from '../src/surfaces/headless.ts';

/** Point the harness at a throwaway home so tests never touch ~/.harness. */
export function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  process.env.HARNESS_HOME = home;
  return home;
}

/** A small project for the agent to survey. */
export function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-project-'));
  writeFileSync(join(dir, 'README.md'), '# Sample\n\nA tiny project used in tests.\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
  writeFileSync(join(dir, 'index.ts'), 'export const answer = 42;\n');
  return dir;
}

export interface HarnessFixture {
  store: ThreadStore;
  session: Session;
  lines: string[];
  cwd: string;
}

export function makeSession(opts: {
  cwd?: string;
  answers?: AnswerFile;
  policy?: AskPolicy;
  yolo?: boolean;
  deniedTools?: string[];
  maxGateNudges?: number;
} = {}): HarnessFixture {
  const cwd = opts.cwd ?? makeProject();
  const store = ThreadStore.create({ cwd, model: 'scripted' });
  const lines: string[] = [];
  const surface = new HeadlessSurface({
    answers: opts.answers,
    policy: opts.policy ?? 'allow',
    out: (line) => lines.push(line),
  });
  const session = new Session({
    store,
    provider: new ScriptedProvider(),
    surface,
    yolo: opts.yolo,
    deniedTools: opts.deniedTools,
    maxGateNudges: opts.maxGateNudges,
  });
  return { store, session, lines, cwd };
}

export const APPROVE_ALL: AnswerFile = {
  plan: 'approve',
  confirm: { write_file: 'approve_always', run_command: 'approve' },
  ask: { 'file tree': 'No — prose only' },
};
