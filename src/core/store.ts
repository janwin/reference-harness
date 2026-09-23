import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import type { HarnessEvent, HarnessEventBody } from './events.ts';
import { eventLogPath, newId, snapshotPath, threadDir, threadsDir } from './paths.ts';
import { apply, initialState, replay, type ThreadState } from './state.ts';

const SNAPSHOT_EVERY = 20;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function atomicWrite(path: string, contents: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

function parseLines(raw: string): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as HarnessEvent);
    } catch {
      // A torn final line means we crashed mid-append. Everything before it is
      // still valid, which is the whole reason the log is append-only.
      break;
    }
  }
  return out;
}

/**
 * Append-only event log with periodic snapshots.
 *
 * Writers append; readers (a second terminal) tail from a byte offset. Nobody
 * ever rewrites history, so a crash costs at most the final partial line.
 */
export class ThreadStore {
  readonly id: string;

  private state: ThreadState;
  private bytesRead = 0;
  private listeners = new Set<(event: HarnessEvent, state: ThreadState) => void>();

  private constructor(id: string, state: ThreadState, bytesRead: number) {
    this.id = id;
    this.state = state;
    this.bytesRead = bytesRead;
  }

  /** Create a brand new thread on disk. */
  static create(opts: { cwd: string; model: string; mode?: 'plan' | 'build'; id?: string }): ThreadStore {
    const id = opts.id ?? newId();
    ensureDir(threadDir(id));
    writeFileSync(eventLogPath(id), '', { flag: 'a' });
    const store = new ThreadStore(id, initialState(id), 0);
    store.append({
      type: 'thread_created',
      cwd: opts.cwd,
      model: opts.model,
      mode: opts.mode ?? 'plan',
    });
    return store;
  }

  /** Open an existing thread: load snapshot, replay the tail. */
  static open(id: string): ThreadStore {
    if (!existsSync(eventLogPath(id))) {
      throw new Error(`no such thread: ${id}`);
    }

    let base = initialState(id);
    let skip = 0;
    if (existsSync(snapshotPath(id))) {
      try {
        const snap = JSON.parse(readFileSync(snapshotPath(id), 'utf8')) as {
          seq: number;
          state: ThreadState;
        };
        base = snap.state;
        skip = snap.seq;
      } catch {
        // Corrupt snapshot: fall back to a full replay. Snapshots are a cache,
        // never the source of truth.
        base = initialState(id);
        skip = 0;
      }
    }

    const raw = readFileSync(eventLogPath(id), 'utf8');
    const events = parseLines(raw).filter((e) => e.seq > skip);
    const state = replay(id, events, base);
    return new ThreadStore(id, state, Buffer.byteLength(raw, 'utf8'));
  }

  static exists(id: string): boolean {
    return existsSync(eventLogPath(id));
  }

  /** Threads, most recently modified first. */
  static list(): Array<{ id: string; updatedAt: Date }> {
    const dir = threadsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((id) => existsSync(eventLogPath(id)))
      .map((id) => ({ id, updatedAt: statSync(eventLogPath(id)).mtime }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  static latest(): string | null {
    return ThreadStore.list()[0]?.id ?? null;
  }

  get current(): ThreadState {
    return this.state;
  }

  /** Append an event, advance state, notify local listeners. */
  append(body: HarnessEventBody): HarnessEvent {
    const event: HarnessEvent = {
      ...body,
      seq: this.state.seq + 1,
      ts: new Date().toISOString(),
    };

    const line = `${JSON.stringify(event)}\n`;
    // Open/write/close per append: slower than a held handle, but it means a
    // `kill -9` can never lose an event that a caller believes was written.
    const fd = openSync(eventLogPath(this.id), 'a');
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    this.bytesRead += Buffer.byteLength(line, 'utf8');

    this.state = apply(this.state, event);
    if (event.seq % SNAPSHOT_EVERY === 0) this.snapshot();

    for (const listener of this.listeners) listener(event, this.state);
    return event;
  }

  snapshot(): void {
    atomicWrite(snapshotPath(this.id), JSON.stringify({ seq: this.state.seq, state: this.state }));
  }

  /** Read events appended by *another* process since our last read. */
  pull(): HarnessEvent[] {
    const path = eventLogPath(this.id);
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    if (size <= this.bytesRead) return [];

    const raw = readFileSync(path, 'utf8');
    const fresh = parseLines(raw).filter((e) => e.seq > this.state.seq);
    this.bytesRead = Buffer.byteLength(raw, 'utf8');
    for (const event of fresh) {
      this.state = apply(this.state, event);
      for (const listener of this.listeners) listener(event, this.state);
    }
    return fresh;
  }

  /** Full history, for `harness replay`. */
  readAll(): HarnessEvent[] {
    return parseLines(readFileSync(eventLogPath(this.id), 'utf8'));
  }

  onEvent(listener: (event: HarnessEvent, state: ThreadState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
