# harness-mvp

A minimal agent harness, built to show what a harness *is*.

The agent here is deliberately trivial: it surveys a directory and writes a
`NOTES.md`. Everything interesting is the machinery around it — the part that
turns a `model.complete()` call into something you can actually work with.

```bash
npm install
npm run demo          # guided tour of all eight capabilities, no API key needed
npm run harness       # interactive
npm test
```

## The point

A bare model call is a function: input in, output out, nothing survives it.
A harness is what you add so that the following are true:

| Without a harness | With one |
|---|---|
| Close the terminal, lose the work | The thread is on disk; reopen and continue |
| The agent decides it is done | A task list it must close before it can finish |
| One request, then wait | Type over it, queue a follow-up, abort and redirect |
| Tools either run or they don't | An ordered rule chain decides, and records why |
| "Please don't edit anything yet" | Plan mode where writes are *impossible*, not discouraged |
| Prompts block forever in CI | The same pauses fall back to plain text |
| One process owns everything | Two terminals on one thread, one writer |

## Architecture

```
src/
  core/      events · state (pure reducer) · store (append-only log) · lock (lease)
  perms/     the ordered approval chain
  tools/     list_files read_file write_file run_command
             ask_user todo_write exit_plan_mode spawn_subagent
  model/     provider interface · scripted (offline) · anthropic (real)
  loop/      session (turn loop, queue, abort) · prompt assembly · crash recovery
  surfaces/  interactive TTY · headless · follower (read-only)
  ui/        raw-mode terminal · event renderer · repl
```

The single rule everything else follows from: **state changes only by appending
an event.** Persistence, crash recovery, and a second terminal following along
are then all the same mechanism seen from different angles.

### 1. Thread persistence

`$HARNESS_HOME/threads/<id>/events.jsonl` plus a snapshot every 20 events.
`ThreadState` is derived by a pure reducer, so reopening restores mode, model,
cumulative tokens (including cache reads), memory settings, todos and grants
exactly. A torn final line from a `kill -9` costs that one line and nothing else.

```bash
npm run harness -- -c          # resume the most recent thread
npm run harness -- threads     # list them
npm run harness -- replay <id> # re-render the whole conversation from the log
```

### 2. Live task lists

`todo_write` writes into thread state, so the list renders live and survives a
restart. The loop enforces a **completion gate**: if the model stops while items
are open, the harness injects a turn naming them instead of ending. The agent
cannot declare itself done. After 3 nudges the turn ends `incomplete` rather
than looping forever.

### 3. Interrupt / queue / steer

Raw-mode stdin, so the conversation stays an open channel:

- type while it works → queued, delivered at the next step (`queued:2` in the status line)
- `Esc` → `AbortController.abort()`; the turn ends `interrupted`, the thread survives
- `Esc Esc` → also discards the queue

A queued message is recorded with `source: 'queued'`, so the agent can tell
steering from a fresh request.

### 4. Tools that pause for humans

`ask_user` and `exit_plan_mode` suspend the loop on a promise that a *surface*
resolves. In a terminal that is a picker. Headless it is a printed block:

```
=== HUMAN INPUT REQUIRED (ask_user) ===
Q: Should NOTES.md include a full file tree?
Options: Yes — include the tree | No — prose only
Resolution: --on-ask deny → refusing to answer
```

resolved from `--answers file.json`, else by `--on-ask deny|allow|default`.
It never blocks — a harness that hangs on stdin in CI is worse than one that
refuses.

### 5. Plan → build handoff

Plan mode hides the write tools *and* hard-denies them in the chain. Approving
an `exit_plan_mode` plan does two things at once: flips the mode to `build`, and
seeds the approved steps into the todo list (without discarding work already
queued there).

### 6. The approval chain

Ordered; first decisive rule wins; the decision and the deciding rule are both
written to the log.

```
1. deny-rules       hard DENY  — .git writes, escapes from cwd, rm -rf, sudo, curl|sh
2. mode-policy      DENY       — writes and commands while in plan mode
3. yolo             ALLOW      — --yolo
4. session-grants   ALLOW      — an earlier "always allow", persisted on the thread
5. category-policy  read/meta/human allow · write/exec ask · network deny
6. ask-fallback     ASK the human
```

`mode-policy` outranks both `yolo` and standing grants deliberately: "read-only"
is worth nothing if a flag or an hour-old grant can quietly undo it.

```bash
npm run harness -- explain --thread <id>
```

### 7. Subagents

- `isolated` — fresh context, read-only tools, its own budget. It has not seen
  the parent's reasoning, so it cannot rubber-stamp it. Used here to review
  `NOTES.md` against the actual directory.
- `fork` — inherits the parent's prefix verbatim, so a real provider bills it as
  `cache_read`. Cheap, but it shares the parent's blind spots.

Both are billed back to the thread, so the cost is visible in the status line.

### 8. Crash recovery and multi-surface

`lock.json` holds a heartbeated lease (`pid`, `host`, `heartbeatAt`). The first
terminal writes; a second opens as a **follower** that tails the log read-only
and offers `/takeover` once the lease goes stale. On startup, a `turn_started`
with no matching `turn_ended` means a crash: it is closed as `interrupted` and
the request that was in flight is handed back.

## Running against a real model

The default provider is offline and deterministic. For the real thing:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run harness -- --model claude-sonnet-5
```

Nothing in `loop/`, `perms/`, `core/` or `tools/` changes — the provider is the
only thing that knows an API exists. The system prompt and tool definitions are
sent with `cache_control`, which is what makes a `fork` subagent cheap.

## CI

```bash
npm run harness -- --headless -p "summarise this directory" \
  --cwd ./some-project --answers answers.example.json
```

Exits non-zero if the turn did not complete. Same agent, same chain, no TTY.


## What is a harness? (for non-technical readers)

A large language model (LLM) on its own can only do one thing: read text and write text back. It can't look anything up, it forgets everything between conversations, and it has no way to act in the world.

A **harness** is the software wrapped around the model that turns it into something that can actually get work done. A good comparison is a horse and its tack. The horse supplies the power, and the harness, reins, and saddle point that power in a useful direction and keep everyone safe.

In practice, the harness:

- **Gives the model tools.** It lets the model search the web, read files, query a database, or send an email. The model asks, and the harness carries out the action.
- **Decides what the model sees.** A model can only read a limited amount at once, so the harness picks the instructions, history, and documents that matter for the current step.
- **Sets the rules.** The harness enforces what the model is and isn't allowed to do, and asks a human before anything risky or irreversible.
- **Keeps it on track.** It runs the model step by step toward a goal, catches mistakes, retries when something fails, and knows when to stop.
- **Makes it accountable.** It records what happened, what it cost, and why, so the system can be audited and improved.

**Why it matters to the business:** two products built on the *same* model can differ enormously in quality, cost, and safety. Most of that difference comes from the harness. The harness is where reliability, compliance, and user trust are engineered in.

---

## What the harness architecture is for

The architecture separates the concerns that every production agent needs, so each can be built, tested, and replaced independently:

```
                ┌──────────────────────────────────────────┐
                │                Interface                  │
                │         (CLI · API · chat · jobs)         │
                └───────────────────┬──────────────────────┘
                                    │
┌───────────────┐   ┌───────────────▼──────────────┐   ┌─────────────────┐
│    Context    │──▶│          Agent Loop          │◀──│     Policy &    │
│   Manager     │   │  plan → call model → act →   │   │   Permissions   │
│ (prompt, mem, │   │  observe → repeat / stop     │   │ (allow / ask /  │
│  retrieval)   │   └───────┬───────────────┬──────┘   │     deny)       │
└───────────────┘           │               │          └─────────────────┘
                   ┌────────▼─────┐  ┌──────▼────────┐
                   │ Model Client │  │ Tool Registry │──▶ sandboxed execution
                   │ (provider-   │  │ (typed schemas│
                   │  agnostic)   │  │  + handlers)  │
                   └──────────────┘  └───────────────┘
                                    │
            ┌───────────────────────▼────────────────────────┐
            │  State & Persistence · Observability · Evals   │
            └────────────────────────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| **Agent loop** | Drives the cycle: ask the model, execute any tool calls, feed results back, and stop on completion, budget, or error. |
| **Model client** | A thin, provider-agnostic interface to the LLM. Handles streaming, retries, and rate limits. |
| **Tool registry** | Declares tools with typed input/output schemas and routes calls to handlers. |
| **Context manager** | Assembles what the model sees each turn (system prompt, relevant history, retrieved documents) and compacts it when it grows too large. |
| **Policy & permissions** | Decides for each action whether it is allowed, needs human approval, or is denied. |
| **Sandbox** | Runs side-effecting tools (shell, file writes, network) in an isolated environment. |
| **State & persistence** | Saves sessions so work can be resumed, replayed, or audited. |
| **Observability** | Structured traces of every model call and tool call, with latency, tokens, and cost. |
| **Evals** | Repeatable test scenarios that measure behavior, so changes can be compared objectively. |

---

## Best practices

### 1. Keep the loop simple and explicit
- A single, readable loop beats a framework of hidden callbacks. Anyone should be able to trace one turn end to end.
- Stop for defined reasons only: task complete, max steps, budget exceeded, unrecoverable error, or waiting on a human.

### 2. Design tools for the model, not for the codebase
- Give each tool one clear purpose, a descriptive name, and a precise description. The model picks tools from their descriptions.
- Use strict, typed schemas and validate every input before execution.
- Return concise, structured results. Include actionable error messages ("file not found: did you mean `src/app.ts`?") instead of stack traces.
- Prefer a few well-designed tools over many overlapping ones.

### 3. Treat context as a scarce budget
- Load information just in time (retrieve and read on demand) instead of preloading everything.
- Compact or summarize long histories, and preserve decisions and open tasks when you do.
- Keep stable content (system prompt, tool definitions) at the start of the prompt so it can be cached.

### 4. Enforce safety in code, not in the prompt
- Prompts guide behavior. Policies *enforce* it. Put permission checks in the harness where the model can't talk its way past them.
- Tier actions by risk: read-only (allow), reversible writes (allow or log), irreversible or external effects (require human approval).
- Treat all tool output (web pages, files, emails) as untrusted data, never as instructions. This is the core defense against prompt injection.
- Run side-effecting tools in a sandbox with least-privilege credentials and network allowlists.

### 5. Put humans in the loop at the right points
- Ask for approval before consequential actions, not before every step.
- Make approval requests specific: what will happen, to what, and whether it can be undone.

### 6. Fail gracefully
- Retry transient failures (timeouts, rate limits) with backoff. Surface permanent failures to the model so it can adapt.
- Make tool calls idempotent where possible, and never blindly repeat an action that may already have succeeded.
- Set hard limits on steps, tokens, time, and spend.

### 7. Make everything observable
- Log every model call and tool call as a structured trace with inputs, outputs, latency, tokens, and cost.
- Persist sessions so any run can be replayed and debugged after the fact.

### 8. Measure with evals, not impressions
- Maintain a suite of realistic tasks with clear pass criteria, and run it on every change to prompts, tools, or models.
- Track success rate, cost, and latency together. An improvement in one often costs another.
- Collect real failures from traces and turn them into new eval cases.

### 9. Stay model-agnostic
- Isolate the provider behind the model client so models can be swapped or compared without touching the loop, tools, or policies.

### 10. Keep configuration out of code
- System prompts, tool sets, limits, and policies live in versioned config, so behavior changes are reviewable like any other change.
