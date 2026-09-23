import { homedir } from 'node:os';
import { join } from 'node:path';

/** Overridable so tests (and demos) get their own isolated world. */
export function harnessHome(): string {
  return process.env.HARNESS_HOME ?? join(homedir(), '.harness');
}

export const threadsDir = (): string => join(harnessHome(), 'threads');
export const threadDir = (id: string): string => join(threadsDir(), id);
export const eventLogPath = (id: string): string => join(threadDir(id), 'events.jsonl');
export const snapshotPath = (id: string): string => join(threadDir(id), 'snapshot.json');
export const lockPath = (id: string): string => join(threadDir(id), 'lock.json');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix = ''): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return prefix ? `${prefix}_${out}` : out;
}
