import {
  addUsage,
  emptyUsage,
  type Grant,
  type HarnessEvent,
  type MemorySettings,
  type Message,
  type Mode,
  type Plan,
  type Todo,
  type TokenUsage,
  type TurnStatus,
} from './events.ts';

/**
 * The entire user-visible state of a thread. Derived purely from the event log,
 * never mutated in place — so any two surfaces replaying the same log agree.
 */
export interface ThreadState {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  mode: Mode;
  model: string;
  tokens: TokenUsage;
  memory: MemorySettings;
  messages: Message[];
  todos: Todo[];
  grants: Grant[];
  plan: Plan | null;
  /** Null when idle. Non-null with status 'running' means a turn is in flight. */
  currentTurn: { id: string; status: 'running' } | null;
  lastTurn: { id: string; status: TurnStatus } | null;
  /** Decisions in log order — the material `harness explain` prints. */
  decisions: Array<{
    seq: number;
    callId: string;
    tool: string;
    effect: string;
    rule: string;
    reason: string;
    resolution?: string;
  }>;
  subagents: Array<{
    id: string;
    kind: 'isolated' | 'fork';
    prompt: string;
    report?: string;
    usage?: TokenUsage;
  }>;
  seq: number;
}

export const defaultMemory = (): MemorySettings => ({
  enabled: true,
  windowMessages: 60,
  notes: [],
});

export function initialState(id: string): ThreadState {
  const now = new Date(0).toISOString();
  return {
    id,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
    mode: 'plan',
    model: 'scripted',
    tokens: emptyUsage(),
    memory: defaultMemory(),
    messages: [],
    todos: [],
    grants: [],
    plan: null,
    currentTurn: null,
    lastTurn: null,
    decisions: [],
    subagents: [],
    seq: 0,
  };
}

/**
 * The reducer. Pure: same log in, same state out, on any machine, at any time.
 * This is what makes "close the terminal and reopen" work at all.
 */
export function apply(state: ThreadState, event: HarnessEvent): ThreadState {
  const next: ThreadState = {
    ...state,
    seq: event.seq,
    updatedAt: event.ts,
  };

  switch (event.type) {
    case 'thread_created':
      next.cwd = event.cwd;
      next.model = event.model;
      next.mode = event.mode;
      next.createdAt = event.ts;
      return next;

    case 'user_message':
      next.messages = [
        ...state.messages,
        { role: 'user', text: event.text, synthetic: event.synthetic, source: event.source },
      ];
      return next;

    case 'assistant_message':
      next.messages = [
        ...state.messages,
        { role: 'assistant', text: event.text, toolCalls: event.toolCalls },
      ];
      return next;

    case 'tool_result':
      next.messages = [
        ...state.messages,
        { role: 'tool', text: event.output, toolCallId: event.callId },
      ];
      return next;

    case 'permission_decision':
      next.decisions = [
        ...state.decisions,
        {
          seq: event.seq,
          callId: event.callId,
          tool: event.tool,
          effect: event.effect,
          rule: event.rule,
          reason: event.reason,
          resolution: event.resolution,
        },
      ];
      return next;

    case 'mode_changed':
      next.mode = event.to;
      return next;

    case 'model_changed':
      next.model = event.to;
      return next;

    case 'tokens':
      next.tokens = addUsage(state.tokens, event.usage);
      return next;

    case 'todos_updated':
      next.todos = event.todos;
      return next;

    case 'memory_updated':
      next.memory = event.settings;
      return next;

    case 'grant_added':
      next.grants = [...state.grants, event.grant];
      return next;

    case 'plan_proposed':
      next.plan = event.plan;
      return next;

    case 'turn_started':
      next.currentTurn = { id: event.turnId, status: 'running' };
      return next;

    case 'turn_ended':
      next.currentTurn = null;
      next.lastTurn = { id: event.turnId, status: event.status };
      return next;

    case 'subagent_started':
      next.subagents = [
        ...state.subagents,
        { id: event.subagentId, kind: event.kind, prompt: event.prompt },
      ];
      return next;

    case 'subagent_finished':
      next.subagents = state.subagents.map((s) =>
        s.id === event.subagentId ? { ...s, report: event.report, usage: event.usage } : s,
      );
      next.tokens = addUsage(state.tokens, event.usage);
      return next;

    case 'tool_call':
    case 'note':
      return next;

    default: {
      // Unknown event kinds are ignored rather than fatal, so an older binary can
      // still open a thread written by a newer one.
      return next;
    }
  }
}

export function replay(id: string, events: HarnessEvent[], from?: ThreadState): ThreadState {
  return events.reduce(apply, from ?? initialState(id));
}

export const openTodos = (state: ThreadState): Todo[] =>
  state.todos.filter((t) => t.status !== 'completed');
