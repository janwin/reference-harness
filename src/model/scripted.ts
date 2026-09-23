import type { Message, ToolCall } from '../core/events.ts';
import {
  estimateRequestTokens,
  estimateTokens,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './provider.ts';

/**
 * A deterministic stand-in for a real model.
 *
 * It plays one job convincingly — survey a directory, propose a plan, write
 * NOTES.md, get it reviewed — and it does so by reading the transcript, exactly
 * like a real model would. That makes every harness behaviour (the approval
 * chain, the todo gate, interrupts, plan→build, subagents) testable without a
 * network call or a dollar of spend.
 *
 * It deliberately tries to finish once while todos are still open, so the
 * completion gate has something to catch.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');

    const view = analyze(req.messages);
    const decision =
      req.role === 'subagent'
        ? reviewPhase(req)
        : req.mode === 'plan'
          ? planPhase(req, view)
          : buildPhase(req, view);

    const inputTokens = estimateRequestTokens(req);
    const outputTokens =
      estimateTokens(decision.text) + estimateTokens(JSON.stringify(decision.toolCalls));

    // A touch of latency so interrupts have something real to cancel.
    await sleep(120, req.signal);

    return {
      ...decision,
      usage: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 },
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface TranscriptView {
  callCounts: Record<string, number>;
  /** Tool output keyed by tool name, most recent last. */
  results: Record<string, string[]>;
  /** Messages typed while a turn was already running — i.e. steering. */
  steers: string[];
  /** How many steers the script has already acknowledged. */
  acked: number;
  /** Harness-injected nudges (the completion gate). */
  nudges: number;
  planRejections: number;
  nextCallId: string;
}

const ACK = '[ack]';

function analyze(messages: Message[]): TranscriptView {
  const callCounts: Record<string, number> = {};
  const results: Record<string, string[]> = {};
  const callNames = new Map<string, string>();
  const steers: string[] = [];
  let acked = 0;
  let nudges = 0;
  let planRejections = 0;
  let totalCalls = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.synthetic) nudges += 1;
      else if (message.source === 'queued') steers.push(message.text);
      continue;
    }

    if (message.role === 'assistant') {
      if (message.text.includes(ACK)) acked += 1;
      for (const call of message.toolCalls ?? []) {
        callCounts[call.name] = (callCounts[call.name] ?? 0) + 1;
        callNames.set(call.id, call.name);
        totalCalls += 1;
      }
      continue;
    }

    const name = message.toolCallId ? callNames.get(message.toolCallId) : undefined;
    if (!name) continue;
    (results[name] ??= []).push(message.text);
    if (name === 'exit_plan_mode' && message.text.includes('Plan rejected')) planRejections += 1;
  }

  return {
    callCounts,
    results,
    steers,
    acked,
    nudges,
    planRejections,
    nextCallId: `call_${totalCalls + 1}`,
  };
}

const called = (view: TranscriptView, name: string): number => view.callCounts[name] ?? 0;
const lastResult = (view: TranscriptView, name: string): string =>
  view.results[name]?.at(-1) ?? '';

function call(view: TranscriptView, name: string, input: Record<string, unknown>): ToolCall {
  return { id: view.nextCallId, name, input };
}

type Decision = { text: string; toolCalls: ToolCall[] };

/** Steering beats everything: a new instruction is answered before more work. */
function handleSteer(req: ModelRequest, view: TranscriptView): Decision | null {
  if (view.steers.length <= view.acked) return null;
  const steer = view.steers[view.acked] ?? '';
  return {
    text: `${ACK} Noted mid-flight: "${steer}". Folding that into the current task rather than starting over.`,
    toolCalls: [
      call(view, 'todo_write', {
        todos: [
          ...todosFromState(req),
          { id: `steer${view.acked + 1}`, text: `Address steer: ${steer}`, status: 'pending' },
        ],
      }),
    ],
  };
}

/**
 * The subagent's script. It only ever sees the messages after its own prompt —
 * which for an `isolated` subagent is all there is, and for a `fork` is the tail
 * of an inherited context.
 */
function reviewPhase(req: ModelRequest): Decision {
  const start = req.messages.map((m) => m.role).lastIndexOf('user');
  const tail = req.messages.slice(start);
  const view = analyze(tail);
  const id = `sub_call_${tail.filter((m) => m.role === 'assistant').length + 1}`;

  if (called(view, 'list_files') === 0) {
    return {
      text: 'Looking at the directory with fresh eyes.',
      toolCalls: [{ id, name: 'list_files', input: { dir: '.', depth: 1 } }],
    };
  }

  if (called(view, 'read_file') === 0) {
    return {
      text: 'Reading the file I am meant to review.',
      toolCalls: [{ id, name: 'read_file', input: { path: 'NOTES.md' } }],
    };
  }

  const listing = lastResult(view, 'list_files');
  const notes = lastResult(view, 'read_file');
  const realFiles = listing.split('\n').filter((l) => l.trim() && !l.endsWith('/')).length;
  const claimed = /(\d+)\s+files/.exec(notes)?.[1];
  const agrees = claimed !== undefined && Number(claimed) === realFiles;

  return {
    text: [
      `Reviewed NOTES.md against the directory (${realFiles} files visible at depth 1).`,
      claimed === undefined
        ? 'NOTES.md does not state a file count, so there is nothing to contradict.'
        : agrees
          ? `Its claim of ${claimed} files is consistent with what I see.`
          : `It claims ${claimed} files; I count ${realFiles} at depth 1 — check the depth used.`,
      'No fabricated files spotted in the listing it reproduces.',
    ].join('\n'),
    toolCalls: [],
  };
}

function planPhase(req: ModelRequest, view: TranscriptView): Decision {
  const steer = handleSteer(req, view);
  if (steer) return steer;

  if (called(view, 'list_files') === 0) {
    return {
      text: 'Surveying the directory before proposing anything.',
      toolCalls: [call(view, 'list_files', { dir: '.', depth: 2 })],
    };
  }

  if (called(view, 'read_file') === 0) {
    const target = pickFile(lastResult(view, 'list_files'));
    return {
      text: `Reading ${target} to understand what this project is.`,
      toolCalls: [call(view, 'read_file', { path: target })],
    };
  }

  if (called(view, 'ask_user') === 0) {
    return {
      text: 'One question before I commit to a plan.',
      toolCalls: [
        call(view, 'ask_user', {
          question: 'Should NOTES.md include a full file tree?',
          options: ['Yes — include the tree', 'No — prose only'],
          context: 'It changes how long the file gets.',
        }),
      ],
    };
  }

  const withTree = lastResult(view, 'ask_user').toLowerCase().includes('yes');

  if (called(view, 'exit_plan_mode') === 0) {
    return {
      text: 'Here is what I intend to do.',
      toolCalls: [
        call(view, 'exit_plan_mode', {
          summary: 'Survey this directory and write a NOTES.md describing what it contains.',
          steps: [
            'Read the key files at the top of the directory',
            withTree ? 'Write NOTES.md with a summary and a file tree' : 'Write NOTES.md with a prose summary',
            'Have an isolated subagent review NOTES.md against the real files',
          ],
        }),
      ],
    };
  }

  // One rejection earns one revision. A second means the human wants something
  // this agent is not going to guess — so it stops rather than looping.
  if (view.planRejections === 1) {
    return {
      text: 'Rejected — here is a smaller version.',
      toolCalls: [
        call(view, 'exit_plan_mode', {
          summary: 'Write a short NOTES.md and nothing else.',
          steps: ['Write NOTES.md with a two-line summary of the directory'],
        }),
      ],
    };
  }

  if (view.planRejections >= 2) {
    return {
      text: 'Two plans rejected, and I am still in read-only plan mode. Rather than guess a third time: what should the plan be?',
      toolCalls: [],
    };
  }

  return { text: 'Waiting on plan approval before doing anything that writes.', toolCalls: [] };
}

function buildPhase(req: ModelRequest, view: TranscriptView): Decision {
  const steer = handleSteer(req, view);
  if (steer) return steer;

  const todos = todosFromState(req);

  if (todos.length > 0 && todos.every((t) => t.status === 'pending')) {
    return {
      text: 'Starting on step one.',
      toolCalls: [
        call(view, 'todo_write', {
          todos: todos.map((t, i) => ({ ...t, status: i === 0 ? 'in_progress' : t.status })),
        }),
      ],
    };
  }

  if (called(view, 'read_file') < 2) {
    const target = pickFile(lastResult(view, 'list_files'), 1);
    return {
      text: `Reading ${target} as well before I write anything down.`,
      toolCalls: [call(view, 'read_file', { path: target })],
    };
  }

  if (called(view, 'write_file') === 0) {
    return {
      text: 'Writing NOTES.md.',
      toolCalls: [
        call(view, 'write_file', {
          path: 'NOTES.md',
          content: composeNotes(view),
        }),
      ],
    };
  }

  if (called(view, 'spawn_subagent') === 0) {
    return {
      text: 'Getting a second pair of eyes that has not seen my reasoning.',
      toolCalls: [
        call(view, 'spawn_subagent', {
          kind: 'isolated',
          prompt:
            'Read NOTES.md and the directory it describes. Does the file match reality? Answer in three lines.',
        }),
      ],
    };
  }

  // Deliberately premature: the completion gate should catch this.
  if (view.nudges === 0) {
    return { text: 'All done — NOTES.md is written and reviewed.', toolCalls: [] };
  }

  const open = todos.filter((t) => t.status !== 'completed');
  if (open.length > 0) {
    return {
      text: 'Fair — the list was still open. Closing it out properly.',
      toolCalls: [
        call(view, 'todo_write', {
          todos: todos.map((t) => ({ ...t, status: 'completed' })),
        }),
      ],
    };
  }

  return {
    text: [
      'Done, and this time the task list agrees.',
      '',
      '- Surveyed the directory and read the key files',
      '- Wrote NOTES.md',
      '- Had an isolated subagent check it against the real files',
    ].join('\n'),
    toolCalls: [],
  };
}

/**
 * Real todo state comes from the harness, not from the transcript — the script
 * reads it the same way a model reads its context.
 */
function todosFromState(req: ModelRequest): Array<{ id: string; text: string; status: string }> {
  const marker = req.system.indexOf(TODO_MARKER);
  if (marker === -1) return [];
  const json = req.system.slice(marker + TODO_MARKER.length).split('\n')[0] ?? '[]';
  try {
    return JSON.parse(json) as Array<{ id: string; text: string; status: string }>;
  } catch {
    return [];
  }
}

export const TODO_MARKER = '<todos-json>';

function pickFile(listing: string, offset = 0): string {
  const files = listing
    .split('\n')
    .map((line) => line.replace(/\s*\(\d+b\)$/, '').trim())
    .filter((line) => line && !line.endsWith('/'));

  const preferred = ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'index.ts'];
  const ranked = [
    ...preferred.filter((p) => files.includes(p)),
    ...files.filter((f) => !preferred.includes(f)),
  ];
  return ranked[offset] ?? ranked[0] ?? '.';
}

function composeNotes(view: TranscriptView): string {
  const listing = lastResult(view, 'list_files');
  const entries = listing.split('\n').filter(Boolean);
  const dirs = entries.filter((e) => e.endsWith('/'));
  const files = entries.filter((e) => !e.endsWith('/'));
  const steerNotes = view.steers.map((s) => `- ${s}`);

  return [
    '# NOTES',
    '',
    `Surveyed by the harness example agent. ${files.length} files across ${dirs.length} directories.`,
    '',
    '## Top-level contents',
    '',
    ...entries.slice(0, 40).map((e) => `- ${e}`),
    '',
    ...(steerNotes.length ? ['## Steering received mid-task', '', ...steerNotes, ''] : []),
    '## What I read',
    '',
    ...(view.results.read_file ?? []).map(
      (content, i) => `${i + 1}. ${content.split('\n')[0]?.slice(0, 80) ?? '(empty)'}`,
    ),
    '',
  ].join('\n');
}
