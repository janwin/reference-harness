import {
  addUsage,
  emptyUsage,
  totalTokens,
  type Grant,
  type Plan,
  type Todo,
  type TokenUsage,
  type ToolCall,
  type TurnStatus,
} from '../core/events.ts';
import { newId } from '../core/paths.ts';
import { openTodos, type ThreadState } from '../core/state.ts';
import type { ThreadStore } from '../core/store.ts';
import type { ModelProvider } from '../model/provider.ts';
import { evaluate, subjectOf, type ChainResult } from '../perms/chain.ts';
import type { Surface } from '../surfaces/types.ts';
import { toolsForMode, toolByName } from '../tools/index.ts';
import { listFiles, readFile } from '../tools/fs.ts';
import type { SessionApi, Tool, ToolContext } from '../tools/types.ts';
import { buildContext, buildSystemPrompt, gateNudge } from './prompt.ts';

const MAX_GATE_NUDGES = 3;
const MAX_STEPS_PER_TURN = 24;
/** How many times an identical tool call may repeat in one turn before we stop. */
const MAX_IDENTICAL_CALLS = 3;
const SUBAGENT_TOOLS: Tool[] = [listFiles, readFile];
const SUBAGENT_MAX_STEPS = 6;

export interface SessionOptions {
  store: ThreadStore;
  provider: ModelProvider;
  surface: Surface;
  yolo?: boolean;
  deniedTools?: string[];
  maxGateNudges?: number;
}

/**
 * A running conversation. Owns the turn loop, the steer queue, the abort signal
 * and the permission decisions — i.e. everything a bare `model.complete()` call
 * does not give you.
 */
export class Session implements SessionApi {
  readonly store: ThreadStore;
  readonly surface: Surface;

  private provider: ModelProvider;
  private yolo: boolean;
  private deniedTools: string[];
  private maxGateNudges: number;

  /** Messages typed while the agent was busy, delivered at the next boundary. */
  private queue: string[] = [];
  private controller: AbortController | null = null;

  constructor(opts: SessionOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.surface = opts.surface;
    this.yolo = opts.yolo ?? false;
    this.deniedTools = opts.deniedTools ?? [];
    this.maxGateNudges = opts.maxGateNudges ?? MAX_GATE_NUDGES;
  }

  get state(): ThreadState {
    return this.store.current;
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  get queued(): readonly string[] {
    return this.queue;
  }

  /** Type over a running task: the text lands at the next turn boundary. */
  enqueue(text: string): void {
    this.queue.push(text);
  }

  clearQueue(): void {
    this.queue = [];
  }

  /** Esc: cancel the in-flight model call or tool, keep the thread. */
  interrupt(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  // ---------------------------------------------------------------- SessionApi

  setTodos(todos: Todo[]): void {
    this.store.append({ type: 'todos_updated', todos });
  }

  proposePlan(plan: Plan): void {
    this.store.append({ type: 'plan_proposed', plan });
  }

  switchMode(to: 'plan' | 'build', reason: string): void {
    const from = this.state.mode;
    if (from === to) return;
    this.store.append({ type: 'mode_changed', from, to, reason });
  }

  /**
   * Approving a plan adds its steps to the list; it does not wipe work that was
   * already queued up there (a steer that arrived during planning, say).
   */
  seedTodosFromPlan(plan: Plan): void {
    const carried = this.state.todos.filter((t) => t.status !== 'completed');
    this.setTodos([
      ...carried,
      ...plan.steps.map((step, index) => ({
        id: `p${index + 1}`,
        text: step.text,
        status: 'pending' as const,
      })),
    ]);
  }

  setMemory(patch: Partial<ThreadState['memory']>): void {
    this.store.append({ type: 'memory_updated', settings: { ...this.state.memory, ...patch } });
  }

  setModel(provider: ModelProvider): void {
    const from = this.state.model;
    this.provider = provider;
    if (from !== provider.name) {
      this.store.append({ type: 'model_changed', from, to: provider.name });
    }
  }

  // --------------------------------------------------------------- the turn loop

  async run(userText: string): Promise<TurnStatus> {
    const turnId = newId('turn');
    this.store.append({ type: 'turn_started', turnId });
    this.store.append({ type: 'user_message', text: userText, source: 'typed' });

    this.controller = new AbortController();
    const signal = this.controller.signal;

    let status: TurnStatus = 'completed';
    let nudges = 0;
    const repeats = new Map<string, number>();

    try {
      for (let step = 0; step < MAX_STEPS_PER_TURN; step += 1) {
        this.drainQueue();

        const response = await this.provider.complete({
          system: buildSystemPrompt(this.state),
          messages: buildContext(this.state),
          tools: toolsForMode(this.state.mode),
          mode: this.state.mode,
          signal,
        });

        this.store.append({ type: 'tokens', usage: response.usage, source: 'main' });
        this.store.append({
          type: 'assistant_message',
          text: response.text,
          toolCalls: response.toolCalls,
        });
        if (response.text.trim()) this.surface.notify(`\n${response.text.trim()}`);

        if (response.toolCalls.length > 0) {
          // An agent that keeps making the same rejected call is stuck, not
          // persistent. The harness breaks the loop; the model cannot.
          const looping = response.toolCalls.find(
            (call) => bump(repeats, signatureOf(call)) > MAX_IDENTICAL_CALLS,
          );
          if (looping) {
            this.surface.notify(
              `[harness] stopping: '${looping.name}' was retried identically ${MAX_IDENTICAL_CALLS} times`,
            );
            this.store.append({
              type: 'note',
              text: `loop guard tripped on ${looping.name}`,
            });
            status = 'incomplete';
            break;
          }

          for (const call of response.toolCalls) {
            await this.executeTool(call, signal);
          }
          continue;
        }

        // No tool calls: the model thinks it is finished.
        if (this.queue.length > 0) continue; // …but a steer is waiting. Keep going.

        const open = openTodos(this.state);
        if (open.length === 0) break;

        if (nudges >= this.maxGateNudges) {
          this.surface.notify(
            `[harness] giving up after ${nudges} nudges — ${open.length} task(s) still open`,
          );
          status = 'incomplete';
          break;
        }

        nudges += 1;
        const nudge = gateNudge(open.map((t) => t.text));
        this.surface.notify(`\n${nudge}`);
        this.store.append({ type: 'user_message', text: nudge, synthetic: true });
      }
    } catch (error) {
      status = signal.aborted ? 'interrupted' : 'error';
      if (status === 'error') {
        const message = error instanceof Error ? error.message : String(error);
        this.store.append({ type: 'note', text: `turn error: ${message}` });
        this.surface.notify(`[harness] error: ${message}`);
      } else {
        this.surface.notify('[harness] interrupted — thread kept, tell me what to do instead');
      }
    } finally {
      this.controller = null;
      this.store.append({ type: 'turn_ended', turnId, status });
      this.store.snapshot();
    }

    return status;
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const text of pending) {
      this.surface.notify(`[harness] delivering queued message: ${text}`);
      this.store.append({ type: 'user_message', text, source: 'queued' });
    }
  }

  // ------------------------------------------------------------ tool execution

  private async executeTool(call: ToolCall, signal: AbortSignal): Promise<void> {
    const available = toolsForMode(this.state.mode);
    const tool = toolByName(call.name, available);

    this.store.append({ type: 'tool_call', call });

    if (!tool) {
      this.store.append({
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        ok: false,
        output: `unknown tool '${call.name}' in ${this.state.mode} mode`,
      });
      return;
    }

    const decision = this.decide(tool, call);
    const allowed = await this.resolve(tool, call, decision);
    if (!allowed) return;

    try {
      const ctx: ToolContext = {
        cwd: this.state.cwd,
        state: this.state,
        signal,
        surface: this.surface,
        session: this,
      };
      const result = await tool.run(call.input, ctx);
      this.store.append({
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        ok: result.ok,
        output: result.output,
      });
      this.surface.notify(
        `  ${result.ok ? '✓' : '✗'} ${call.name} ${summarize(call)} — ${firstLine(result.output)}`,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      this.store.append({
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        ok: false,
        output: `tool threw: ${(error as Error).message}`,
      });
    }
  }

  private decide(tool: Tool, call: ToolCall): ChainResult {
    return evaluate({
      tool: tool.name,
      category: tool.category,
      input: call.input,
      mode: this.state.mode,
      cwd: this.state.cwd,
      grants: this.state.grants,
      yolo: this.yolo,
      deniedTools: this.deniedTools,
    });
  }

  /** Record the decision, prompt if the chain said so, return whether to run. */
  private async resolve(tool: Tool, call: ToolCall, decision: ChainResult): Promise<boolean> {
    if (decision.effect === 'allow') {
      this.store.append({
        type: 'permission_decision',
        callId: call.id,
        tool: tool.name,
        effect: 'allow',
        rule: decision.rule,
        reason: decision.reason,
      });
      return true;
    }

    if (decision.effect === 'deny') {
      this.store.append({
        type: 'permission_decision',
        callId: call.id,
        tool: tool.name,
        effect: 'deny',
        rule: decision.rule,
        reason: decision.reason,
      });
      this.store.append({
        type: 'tool_result',
        callId: call.id,
        name: tool.name,
        ok: false,
        output: `Denied by the approval chain (${decision.rule}): ${decision.reason}`,
      });
      this.surface.notify(`  ⛔ ${tool.name} denied by ${decision.rule}: ${decision.reason}`);
      return false;
    }

    const answer = await this.surface.confirm({
      tool: tool.name,
      subject: subjectOf({
        tool: tool.name,
        category: tool.category,
        input: call.input,
        mode: this.state.mode,
        cwd: this.state.cwd,
        grants: this.state.grants,
        yolo: this.yolo,
        deniedTools: this.deniedTools,
      }),
      preview: preview(call),
      decision,
    });

    if (answer === 'approve_always') {
      const grant: Grant = {
        tool: tool.name,
        scope: scopeFor(tool, call, this.state.cwd),
        grantedAt: new Date().toISOString(),
      };
      this.store.append({ type: 'grant_added', grant });
    }

    const approved = answer !== 'reject';
    this.store.append({
      type: 'permission_decision',
      callId: call.id,
      tool: tool.name,
      effect: 'ask',
      rule: decision.rule,
      reason: decision.reason,
      resolution:
        answer === 'approve_always' ? 'approved_always' : approved ? 'approved' : 'rejected',
    });

    if (!approved) {
      this.store.append({
        type: 'tool_result',
        callId: call.id,
        name: tool.name,
        ok: false,
        output: 'The human rejected this call. Do not retry it; choose another approach.',
      });
    }
    return approved;
  }

  // ---------------------------------------------------------------- subagents

  async runSubagent(opts: {
    kind: 'isolated' | 'fork';
    prompt: string;
    signal: AbortSignal;
  }): Promise<{ report: string; usage: TokenUsage }> {
    const subagentId = newId('sub');
    this.store.append({
      type: 'subagent_started',
      subagentId,
      kind: opts.kind,
      prompt: opts.prompt,
    });
    this.surface.notify(`  ↳ ${opts.kind} subagent: ${firstLine(opts.prompt)}`);

    // isolated → fresh context, so its opinion is not anchored on ours.
    // fork     → the parent's prefix verbatim, so the provider's cache still hits.
    const base =
      opts.kind === 'fork'
        ? buildContext(this.state)
        : [];
    const messages = [...base, { role: 'user' as const, text: opts.prompt }];

    let usage = emptyUsage();
    let report = '(subagent produced no report)';
    const transcript = [...messages];

    for (let step = 0; step < SUBAGENT_MAX_STEPS; step += 1) {
      const response = await this.provider.complete({
        system: `${buildSystemPrompt(this.state)}\n\nYou are a ${opts.kind} SUBAGENT. You have read-only tools. Investigate, then reply with your findings as plain text and no tool calls.`,
        messages: transcript,
        tools: SUBAGENT_TOOLS,
        mode: 'plan',
        signal: opts.signal,
        role: 'subagent',
      });
      usage = addUsage(usage, response.usage);

      transcript.push({
        role: 'assistant',
        text: response.text,
        toolCalls: response.toolCalls,
      });

      if (response.toolCalls.length === 0) {
        report = response.text.trim() || report;
        break;
      }

      for (const call of response.toolCalls) {
        const tool = SUBAGENT_TOOLS.find((t) => t.name === call.name);
        const result = tool
          ? await tool.run(call.input, {
              cwd: this.state.cwd,
              state: this.state,
              signal: opts.signal,
              surface: this.surface,
              session: this,
            })
          : { ok: false, output: `subagents may not call '${call.name}'` };
        transcript.push({ role: 'tool', text: result.output, toolCallId: call.id });
      }
    }

    this.store.append({
      type: 'subagent_finished',
      subagentId,
      kind: opts.kind,
      report,
      usage,
    });
    this.surface.notify(
      `  ↳ subagent done (${totalTokens(usage)} tokens, ${usage.cacheRead} cached)`,
    );

    return { report, usage };
  }
}

/** Identity of a call for loop detection: what it does, not which id it carries. */
const signatureOf = (call: ToolCall): string => `${call.name}:${JSON.stringify(call.input)}`;

function bump(counts: Map<string, number>, key: string): number {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
}

function scopeFor(tool: Tool, call: ToolCall, cwd: string): string {
  if (tool.category === 'exec') {
    const command = String(call.input.command ?? '');
    return command.split(/\s+/)[0] ?? '*';
  }
  if (tool.category === 'write') return cwd;
  return '*';
}

function summarize(call: ToolCall): string {
  const subject = call.input.path ?? call.input.dir ?? call.input.command ?? call.input.kind ?? '';
  return subject ? `(${String(subject)})` : '';
}

function preview(call: ToolCall): string | undefined {
  const content = call.input.content;
  if (typeof content !== 'string') return undefined;
  const lines = content.split('\n');
  return lines.length > 12 ? `${lines.slice(0, 12).join('\n')}\n…(${lines.length} lines)` : content;
}

const firstLine = (text: string): string => {
  const line = text.split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};
