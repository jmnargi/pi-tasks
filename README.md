# pi-tasks

Goal + todo tracking for the [pi coding agent](https://pi.dev). The model
keeps a goal and checklist per project, updates it as it works, and **pi
nudges it if it stops with open items** — no more silently-abandoned work.

Modeled on the todo tool of other coding agents (init → start → done, with
phases, blocking, and auto-promotion), built as a first-class pi extension.

## Install

```bash
pi install git:github.com/jmnargi/pi-tasks
```

Then start pi (or `/reload`). No configuration needed. To update after newer
commits are pushed, re-run the same `pi install` command (pi pins git
packages at install time).

## What the model gets

A single `tasks` tool with an `op` parameter:

| op | effect |
|----|--------|
| `init` | Create a plan: `goal` + `todos` (flat) or `phases` (grouped). The first item starts in progress. |
| `view` | Render the current plan (goal, phases, statuses, open counts). |
| `start` | Mark `task` as the current item. |
| `done` | Mark `task` done; the next open item auto-promotes. |
| `drop` | Mark `task` abandoned (no longer counts as open). |
| `block` | Mark `task` blocked with a `reason`. |
| `unblock` | Re-open a blocked item. |
| `append` | Add `todos` (optionally into `phase`). |
| `clear` | Delete the plan for this project. |

Items are addressed by their exact text (they are short verbatim actions —
"what, not how"). A plan persists per project under the pi agent dir, so it
survives across sessions.

### Auto-nudge

On `agent_settled` (pi will not continue running on its own), if the plan has
open items and the agent has done work since the last nudge, the extension
injects a **turn-triggering custom message** (`tasks-nudge` renderer, shown
with a distinct TUI block) listing the goal, the next open item, and the full
plan. A 60s cooldown + "agent acted since last nudge" gate prevents a
nudge→turn→settle→nudge token loop. Closing every item (done/drop/block)
stops the nudges.

### System-prompt appendix

While a plan is active, `before_agent_start` appends a short `[tasks]` block
to the system prompt (goal, open count, current item, and a reminder to keep
the list updated via the `tasks` tool). It appears only when a plan exists,
so it costs nothing when there is no active work, and it keeps even weak
models continuously aware that a goal + checklist is in flight.

## Human-facing

- `/tasks` — show the current project's plan as a notification.
- A `tasks N open` status in the footer while items are open (clears when the
  plan is complete or closed).

## Development

```bash
npm install && npm i -D @types/bun
npx tsc --noEmit      # strict typecheck
bun test              # store, nudge, persistence, factory-surface tests
```

## How it works

- `src/store.ts` — pure goal+todo state machine (statuses, phases, promotion).
- `src/nudge.ts` — pure nudge decisioning (cooldown + activity gate) and
  message shaping.
- `src/persistence.ts` — per-project plan files under the pi agent dir.
- `src/index.ts` — the factory: `tasks` tool, `/tasks` command, nudge events
  (`message_end` activity tracking, `agent_settled`), and the `tasks-nudge`
  message renderer.

## License

MIT.
