# Harness MVP — Design

**Date:** 2026-09-23
**Status:** Approved

## Purpose

Demonstrate what a *harness* is and why it matters. The agent is a dumb loop —
messages in, tool calls out. Everything that makes an agent usable lives in the
harness around it: durable state, an approval chain, interrupts, human pauses,
mode transitions, subagents, and multi-surface coordination.

To keep the point visible, the example agent is deliberately trivial: summarize a
directory and write `NOTES.md`. Every interesting line of code is harness code.

## Non-goals

- MCP support
- Streaming/diff rendering
- Real sandboxing of `run_command` (deny rules + allowlist only)
- Thread management UI beyond `harness threads`

## Stack

Node 22 + TypeScript, run via `tsx` (no build step required). `vitest` for tests.
Model access is pluggable: a deterministic **scripted** provider (default, no API
key, used by tests and the demo) and a real **anthropic** provider behind
`ANTHROPIC_API_KEY`.

## Module layout

```
src/
  core/      events, state reducer, event store, lock, paths
  perms/     the ordered approval chain and its rules
  tools/     list_files read_file write_file run_command ask_user
             todo_write exit_plan_mode spawn_subagent
  model/     provider interface, scripted provider, anthropic provider
  loop/      session (state + queue + abort), agent turn loop
  surfaces/  interactive TTY, headless, follower (read-only)
  ui/        raw-mode line editor, renderer
  cli.ts
```

Each unit is independently testable: the reducer is pure, the chain is pure, the
store is filesystem-only, the loop depends on interfaces (`ModelProvider`,
`Surface`, `Tool`) rather than concrete terminals or APIs.

## 1. Thread persistence

State is an append-only event log, `$HARNESS_HOME/threads/<id>/events.jsonl`,
plus a periodic `snapshot.json` (every 20 events) holding `{seq, state}`.

Every mutation is an event: `user_message`, `assistant_message`, `tool_call`,
`tool_result`, `permission_decision`, `mode_changed`, `model_changed`, `tokens`,
`todos_updated`, `memory_updated`, `grant_added`, `turn_started`, `turn_ended`,
`subagent_started`, `subagent_finished`.

`ThreadState` is derived by a pure reducer `apply(state, event)`. Loading a
thread = read snapshot, replay the tail. That restores mode, model, cumulative
token counts (input/output/cache-read/cache-write), memory settings, todos, and
session grants exactly as they were.

`harness --continue` resumes the most recently updated thread.

## 2. Live task lists

`todo_write` writes the todo array into thread state; the renderer redraws it
above the prompt whenever it changes.

The loop enforces a **completion gate**: when the model returns a final message
with no tool calls, the harness checks for todos that are not `completed`. If any
exist, it does not end the turn — it injects a synthetic user turn naming the
open items and loops again. The agent cannot declare itself done while work is
outstanding. The gate fires at most `MAX_GATE_NUDGES` (3) times, then ends the
turn with status `incomplete` so a stuck agent cannot spin forever.

## 3. Interrupt / queue / steer

The REPL runs stdin in raw mode with a hand-rolled line editor, so input is live
while the agent is working.

- **Typing + Enter during a run** → the line is pushed onto the session queue.
  The status line shows `queue:N`. At the next turn boundary the loop drains the
  queue into the transcript as user messages — that is *steering*, not a new
  conversation.
- **Esc** → `AbortController.abort()` cancels the in-flight model call or tool,
  the turn is recorded `interrupted`, and the prompt returns for a redirect. The
  thread is intact.
- **Esc twice** → also clears the queue.
- **Ctrl+C** → clean shutdown, lock released.

## 4. Tools that pause for humans

`ask_user` and `exit_plan_mode` suspend the loop on a promise resolved by the
active `Surface`:

- `InteractiveSurface` renders a numbered picker in the terminal.
- `HeadlessSurface` (used with `--headless`, or whenever stdin is not a TTY)
  takes the **plain-text fallback**: it prints a structured
  `=== HUMAN INPUT REQUIRED ===` block, then resolves from `--answers <file>`,
  falling back to the `--on-ask` policy (`deny` by default, or `allow` /
  `default`). Fail-closed with a legible reason, never a hang.

The agent code path is identical in both cases; only the surface differs. That is
the point: the same agent runs in a terminal and in CI.

## 5. Plan → build handoff

Two modes. In `plan` the chain hard-denies every `write` and `exec` tool, so
planning is provably read-only. `exit_plan_mode({ summary, steps })` pauses for
approval. On approval the harness does two things atomically:

1. emits `mode_changed: plan → build`
2. seeds the approved steps into the todo list as `pending` items

One human approval, two state effects. On rejection, the mode stays `plan` and
the rejection reason is fed back to the model.

## 6. The approval chain

An ordered list of rules; the first decisive result wins. Every tool call is
evaluated and the decision is written to the log along with the rule that
produced it.

| # | Rule | Effect |
|---|------|--------|
| 1 | `deny-rules` | Hard DENY, never overridable (`.git/` writes, `rm -rf`, writes outside cwd, `sudo`, curl-pipe-shell) |
| 2 | `mode-policy` | DENY write/exec while in `plan` mode |
| 3 | `yolo` | ALLOW everything else when `--yolo` is set |
| 4 | `session-grants` | ALLOW from an earlier "always allow" answer (tool + path/command-prefix scoped) |
| 5 | `category-policy` | read/meta/human → allow, write → ask, exec → ask, network → deny |
| 6 | `ask-fallback` | ASK the human |

`mode-policy` sits above `yolo` and above `session-grants` on purpose: "plan mode
is read-only" is worthless as a guarantee if a flag or an hour-old grant can
quietly undo it.

`evaluate()` returns the decision **and the full trace** of what each rule
returned. `harness explain --thread <id>` prints the recorded decisions, so you
can see exactly why a call ran or did not. That trace is the demo.

Answering an ASK with "always allow" emits `grant_added`, which is persisted —
so grants survive a restart, matching rule 3 on the next run.

## 7. Subagents

`spawn_subagent({ kind, prompt })`:

- `isolated` — fresh context containing only its prompt and a read-only tool set,
  its own token accounting. Returns just its final report. Used for unbiased
  review: "check NOTES.md against the actual repo". It cannot see the parent's
  reasoning, so it cannot rubber-stamp it.
- `fork` — inherits the parent's message prefix verbatim, so on the Anthropic
  provider the cached prefix is reused. Reported as `cache_read` tokens in the
  status line.

Subagent activity is logged into the parent thread as `subagent_started` /
`subagent_finished` with its own token usage, so the cost is visible.

## 8. Crash recovery / multi-surface

`lock.json` holds `{ surfaceId, pid, host, acquiredAt, heartbeatAt }`. The owner
heartbeats every 3s; a lease is stale after 10s.

- First terminal acquires the lease and is the **writer**.
- A second terminal on the same thread starts as a **follower**: it tails
  `events.jsonl` and renders live, with input disabled. If the lease goes stale
  (the writer crashed) or is released, the follower offers takeover (`t`).
- On startup the harness checks for a `turn_started` with no matching
  `turn_ended`. That means a crash mid-turn: it records `turn_ended:interrupted`
  and offers resume-or-discard.

Two terminals therefore see one conversation, and exactly one can write to it.

## Testing

`vitest`, all against the scripted provider so runs are deterministic:

- state reducer round-trip; snapshot + tail replay equals full replay
- permission chain table tests, one per rule, including precedence
- plan-mode read-only enforcement and the plan → build handoff
- todo completion gate (blocks, nudges, gives up after N)
- interrupt aborts an in-flight turn and leaves resumable state
- headless `ask_user` fallback: answers file, `--on-ask` policy, fail-closed
- lock acquire / stale takeover / follower read-only

## Deliverables

- `harness` CLI (`npx tsx src/cli.ts`, or `npm link`)
- `npm run demo` — scripted walkthrough of all eight capabilities
- `README.md` (architecture) and `DEMO.md` (the eight scenarios, by hand)
