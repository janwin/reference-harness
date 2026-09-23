# Driving the demo by hand

`npm run demo` runs all of this non-interactively in about 20 seconds. This file
is for showing it live, in a terminal, where the interesting parts are visible.

Set up a scratch project for the agent to work on:

```bash
export DEMO=$(mktemp -d)
printf '# Widget\n\nA small project.\n' > $DEMO/README.md
printf '{"name":"widget","version":"1.0.0"}\n' > $DEMO/package.json
npm run harness -- --cwd $DEMO
```

---

## 1. Plan mode is read-only, and the plan → build handoff

Type:

> summarise this directory and write NOTES.md

Watch the status line: `mode:plan`. The agent lists files, reads one, and then
**asks you a question** — the loop is suspended on a promise until you answer.

It proposes a plan. Approve with `y`.

Two things happen on that single keystroke: the mode flips to `build` (the
status line changes colour) and the plan's steps appear as a live task list.

**Try rejecting instead** (`n` + a reason). The agent revises once, and if you
reject again it stops and asks you what the plan should be rather than guessing
a third time.

## 2. The approval chain

When it tries to write `NOTES.md` you get the chain, not just a yes/no:

```
· deny-rules       → (defer)
· mode-policy      → (defer)
· yolo             → (defer)
· session-grants   → (defer)
· category-policy  → (defer)
✓ ask-fallback     → ASK  no rule settled 'write_file' — asking the human
```

Press `a` (always). That writes a **grant** to the thread. Check it:

```
/grants
/explain
```

Now demonstrate the rules that cannot be bought off:

```bash
npm run harness -- --yolo --cwd $DEMO
```

Even with `--yolo`, a write into `.git/`, a write outside the cwd, `rm -rf`,
`sudo` and `curl … | sh` are denied by rule 1. And in plan mode, rule 2 denies
every write before `--yolo` is even consulted.

## 3. The completion gate

Let it run to the end. It will announce it is done **while todos are still
open**, and the harness will refuse:

```
[harness] You said you were done, but the task list still has open items:
  - Write NOTES.md with a prose summary
```

It goes back, closes the list properly, and only then finishes.

## 4. Interrupt, queue, steer

Start a fresh request and, while it is working:

- **type something and press Enter** → `queued:1` in the status line. It is
  delivered at the next step and folded into the running task, not treated as a
  new conversation.
- **press `Esc`** → the in-flight call is aborted, the turn ends `interrupted`,
  and you get the prompt back with the thread intact. Say something else and it
  carries on from there.
- **`Esc` twice** → also drops anything queued.

## 5. Thread persistence

Note the thread id in the status line, then kill the terminal outright
(`Ctrl+C`, or close the window mid-task).

```bash
npm run harness -- -c
```

Mode, model, token count, memory settings, task list and grants all come back.
If a turn was still running when you killed it, the harness says so and offers
`/resume`.

Inspect the thread without running anything:

```bash
npm run harness -- threads
npm run harness -- replay <id>
npm run harness -- explain --thread <id>
```

## 6. Two terminals on one thread

With the first terminal still open, in a second one:

```bash
npm run harness -- --thread <id>
```

It opens as a **follower**: `FOLLOWER (read-only)` in the status line. Everything
the first terminal does appears here live — it is tailing the same event log.
Typing is refused.

Now kill the first terminal. Within ten seconds the lease goes stale and the
follower offers `/takeover`.

## 7. Subagents

During the build phase the agent spawns an **isolated** subagent to review
`NOTES.md`. It has a fresh context and read-only tools, so it is checking the
file against the directory rather than agreeing with the reasoning that produced
it — in the demo it catches a file-count mismatch.

The cost is billed back to the thread, so the token counter moves.

## 8. Headless / CI — the same agent, no terminal

```bash
npm run harness -- --headless -p "summarise this directory" \
  --cwd $DEMO --answers answers.example.json
```

Every pause that was a picker is now a printed block with a resolution line
saying where the answer came from. Drop `--answers`:

```bash
npm run harness -- --headless -p "summarise this directory" --cwd $DEMO
```

`--on-ask` defaults to `deny`, so the plan is rejected and nothing is written —
the run refuses rather than guessing, and exits non-zero. `--on-ask allow`
gives it full autonomy instead.
