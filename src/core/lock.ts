import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { lockPath, newId, threadDir } from './paths.ts';

export interface Lease {
  surfaceId: string;
  pid: number;
  host: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export const STALE_MS = 10_000;
export const HEARTBEAT_MS = 3_000;

export type AcquireResult =
  | { ok: true; lease: Lease; tookOver: boolean }
  | { ok: false; heldBy: Lease };

function read(id: string): Lease | null {
  const path = lockPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Lease;
  } catch {
    return null;
  }
}

function alive(lease: Lease): boolean {
  if (lease.host !== hostname()) return true; // can't tell; assume yes
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isStale(lease: Lease, now = Date.now()): boolean {
  return now - lease.heartbeatAt > STALE_MS || !alive(lease);
}

/**
 * Exactly one surface may write to a thread at a time. Everyone else follows.
 *
 * The lease is heartbeated rather than held by a file handle, because the case
 * that matters is a hard crash: nothing runs on exit, so liveness has to be
 * inferred from a timestamp (and a pid probe), not from cleanup.
 */
export class ThreadLock {
  readonly threadId: string;
  readonly surfaceId: string;

  private timer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(threadId: string, surfaceId = newId('srf')) {
    this.threadId = threadId;
    this.surfaceId = surfaceId;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** Whoever currently owns the thread, if anyone. */
  peek(): Lease | null {
    return read(this.threadId);
  }

  acquire(opts: { force?: boolean } = {}): AcquireResult {
    const existing = read(this.threadId);
    if (existing && existing.surfaceId !== this.surfaceId && !isStale(existing) && !opts.force) {
      return { ok: false, heldBy: existing };
    }

    const lease: Lease = {
      surfaceId: this.surfaceId,
      pid: process.pid,
      host: hostname(),
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    mkdirSync(threadDir(this.threadId), { recursive: true });
    writeFileSync(lockPath(this.threadId), JSON.stringify(lease), 'utf8');
    this.held = true;
    this.startHeartbeat();
    return { ok: true, lease, tookOver: Boolean(existing && existing.surfaceId !== this.surfaceId) };
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  beat(): boolean {
    if (!this.held) return false;
    const current = read(this.threadId);
    if (current && current.surfaceId !== this.surfaceId) {
      // Someone took over while we were busy; stop pretending we own this.
      this.held = false;
      this.stopHeartbeat();
      return false;
    }

    if (!existsSync(threadDir(this.threadId))) {
      // The thread itself is gone; there is nothing left to hold.
      this.held = false;
      this.stopHeartbeat();
      return false;
    }

    try {
      writeFileSync(
        lockPath(this.threadId),
        JSON.stringify({
          surfaceId: this.surfaceId,
          pid: process.pid,
          host: hostname(),
          acquiredAt: current?.acquiredAt ?? Date.now(),
          heartbeatAt: Date.now(),
        } satisfies Lease),
        'utf8',
      );
      return true;
    } catch {
      // The thread directory went away underneath us. A heartbeat is a
      // background timer: it must never be the thing that kills the process.
      this.held = false;
      this.stopHeartbeat();
      return false;
    }
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  release(): void {
    this.stopHeartbeat();
    if (!this.held) return;
    const current = read(this.threadId);
    if (current?.surfaceId === this.surfaceId) rmSync(lockPath(this.threadId), { force: true });
    this.held = false;
  }
}
