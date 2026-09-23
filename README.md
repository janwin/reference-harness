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
