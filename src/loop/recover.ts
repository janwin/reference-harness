import type { ThreadStore } from '../core/store.ts';

export interface Recovery {
  crashed: boolean;
  turnId?: string;
  /** The last thing the human actually asked for, so it can be re-run. */
  lastUserMessage?: string;
}

/**
 * A turn that started and never ended means the process died mid-flight.
 *
 * The log cannot tell us *why* it died, and it does not need to: an unterminated
 * turn is by definition unfinished, so we close it as interrupted and hand the
 * human back the request that was in progress.
 */
export function recoverIfCrashed(store: ThreadStore): Recovery {
  const state = store.current;
  if (!state.currentTurn) return { crashed: false };

  const turnId = state.currentTurn.id;
  const lastUserMessage = [...state.messages]
    .reverse()
    .find((m) => m.role === 'user' && !m.synthetic)?.text;

  store.append({ type: 'turn_ended', turnId, status: 'interrupted' });
  store.append({
    type: 'note',
    text: `recovered a turn that was still running when the process exited (${turnId})`,
  });

  return { crashed: true, turnId, lastUserMessage };
}
