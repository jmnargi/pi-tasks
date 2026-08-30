# pi-tasks

Todo-list tracking for the **pi coding agent**. It is a plugin for
[pi](https://github.com/earendil-works/pi). pi is the
`@earendil-works/pi-coding-agent` CLI.

`pi-tasks` gives the model a persistent task list to work against. It makes
**stopping early expensive**. If the model ends its turn while tasks are still
open, pi injects a reminder. The reminder is **a real user message**. It tells
the model to keep working. Work cannot be silently abandoned. A model that
answers once and stops receives the reminder.

- **one `tasks` tool** — init → start → done. It has phases (subgroups),
  blocking, and auto-promotion. It is modeled on the todo tool of other coding
  agents.
- **session-scoped lists** — every session gets its own list. Switching
  sessions never shows another session's tasks.
- **restart-safe** — lists live on disk keyed by the pi session id. The id is
  stable across resume. Tasks survive CLI restarts exactly as long as the
  session does.
- **auto-nudge with a ceiling** — repeated no-progress settles escalate to
  *you* instead of continuing the nudge→turn→settle loop.

**Status:** typechecked (`tsc --noEmit`). Unit-tested (`bun test`, 48 tests
across store / nudge / persistence / ui / factory-surface). See
[Development](#development).

---

## Install

Install and run. **No configuration is needed.**

```bash
pi install git:github.com/jmnargi/pi-tasks   # or: pi install npm:<pkg>
```

The command clones the package into `~/.pi/agent/git/…`. It installs its deps.
It registers the package. pi pins git packages at install time. Re-run the
same `pi install` command to pull newer commits. Then run `/reload` or restart
pi.

**Option B — copy into the auto-discovery directory**

```bash
mkdir -p ~/.pi/agent/extensions/pi-tasks
cp -r src package.json tsconfig.json ~/.pi/agent/extensions/pi-tasks/
cd ~/.pi/agent/extensions/pi-tasks && npm install
```

> **Security:** extensions run with your full system permissions. They can
> execute arbitrary code. Only install from sources you trust.

## Quick start

In a pi session, ask for something multi-step:

```
Fix all failing tests in this repo.
```

The model calls `tasks op=init` with its checklist. It works through the items.
`op=done` auto-promotes the next one. If it stops to chat while items are still
open, pi sends a **user message**. The message arrives on the model's next
turn:

```
[tasks] You stopped your turn, but your todo list still has 2 open tasks — the
work is NOT complete.
Current task: "fix auth module" (Tasks)
Keep working through the list now. Do not stop until every item is closed ...
```

The message uses the exact same channel as your own typing. Even a weak model
treats it as instruction rather than noise.

To check state at any time, ask the model (`tasks op=view`). Or run `/tasks`.

## The `tasks` tool

A single tool with an `op` parameter:

| op | effect |
|----|--------|
| `init` | Create the list: `todos` (flat) or `phases` (subgroups). The first item starts in progress. Refuses to clobber an active list unless `replace: true`. Rejects duplicate item texts. |
| `view` | Render the current list (statuses, open counts). |
| `start` | Mark `task` as the current item (demotes any other active item). |
| `done` | Mark `task` done; the next pending item auto-promotes. Blocked items must be unblocked first. |
| `drop` | Mark `task` abandoned (no longer counts as open). |
| `block` | Mark `task` blocked with a `reason`; re-blocking with an empty reason keeps the old one. |
| `unblock` | Re-open a blocked item. |
| `append` | Add `todos` (optionally into a new/existing `phase`). Duplicate texts are rejected. |
| `clear` | Delete the list for this session. |

Items are addressed by their **exact text** ("what, not how" verbatim actions).
The text is the id. Duplicates are rejected at `init`/`append`. At most one
item is ever `in_progress`. Completing, dropping, or blocking promotes the
earliest pending item automatically.

## Auto-nudge

When pi settles (`agent_settled`) with open items, the extension decides:

1. **Progress gate** — nudging only continues while the open count keeps
   dropping below its low-water mark. A model that answers without touching
   the list stops making "progress".
2. **Activity gate** — the agent must have produced a turn since the last
   nudge. A nudge turn does not re-arm itself.
3. **Cooldown** — 60 s between nudges.
4. **Exhaustion cap** — after **5 consecutive nudges without progress**, pi
   stops nudging. It escalates to *you*. It sends a warning notification. It
   shows a `tasks STUCK` footer status. This continues until an item actually
   closes or the list is cleared or re-inited.

Delivery is `pi.sendUserMessage()`. It is a genuine user message through pi's
prompt flow. It starts a new agent turn. The custom-message renderer
(`tasks-nudge`) remains for contexts that cannot take user messages.

### System-prompt appendix

While tasks are open, `before_agent_start` appends a short `[tasks]` block to
the system prompt. The block shows the open count. It shows the current item.
It reminds the model to keep the list updated. It appears only when there is
an active list. It has zero cost otherwise. Even weak models stay continuously
aware that a checklist is active.

## Live UI

Watching the list is first-class in the pi TUI. All features are best-effort.
They are guarded on `ctx.hasUI`. They fall back silently in `-p`/JSON/RPC
modes:

- **Footer status** (`ctx.ui.setStatus`): `tasks 2/5 · ▸ write tests` while
  work is open. It clears when everything closes. It shows `tasks STUCK` after
  nudge exhaustion.
- **Ambient widget** (`ctx.ui.setWidget`, above the editor): progress bar and
  themed item list while items are outstanding. It disappears when everything
  closes or the list is cleared.
- **`/tasks` fullscreen panel** (`ctx.ui.custom`): the list rendered with a
  progress bar and per-status theming (`▸` active · `✓` done · `!` blocked ·
  `○` pending · `·` dropped). It has inline actions:

  | key | action |
  |-----|--------|
  | ↑/↓ | move selection |
  | enter | start the selected item |
  | x | mark done |
  | b | block (type a reason, enter confirms) |
  | r | reload from disk (the model may have updated it) |
  | esc / q | close |

- **Tool-call rendering** (`renderCall`/`renderResult`): each `tasks` call
  renders as a compact `tasks done · write tests` row. It has a themed result
  line (`2 open · 5 total · next: …`). Expand the tool call to see the full
  themed list instead of raw text.

## How the model learns about this plugin

Nothing is injected without the model's knowledge. All first-party pi
extension surfaces are auditable in `src/index.ts`:

- **Tool schema** (`registerTool`): the `tasks` tool reaches the model like a
  built-in. It has a full op-by-op description.
- **`promptSnippet` + `promptGuidelines`**: one line in the system prompt's
  available-tools listing. Bullets spell out the workflow. The workflow is:
  init before substantial work, update the list during work, address by exact
  text, expect a nudge.
- **System-prompt appendix** (above) only while tasks are open.
- The nudge is delivered through `sendUserMessage`. It is attributed exactly
  like user input. It is not hidden in context.

## Data layout

```
<agentDir>/tasks/
  sessions/<key>.json     # one list per session (key = sid-<hash of session id>;
                          # falls back to proj-<hash of cwd> without a session manager)
```

Lists are small JSON documents. They contain phases, items with status/note,
and timestamps. They are written atomically (temp + rename). A corrupt file
degrades to "no tasks". It does not crash later operations.

## Session scoping

- Every session gets its own list. `session_start` re-keys storage from
  `ctx.sessionManager.getSessionId()`. It resets nudge history. One session's
  exhaustion can never suppress another session's nudges.
- The session id is read back from the session header on resume. Resuming a
  session restores its list across CLI restarts.
- No session manager available (tests/embeds)? Lists fall back to per-cwd
  keys.

## Development

```bash
npm install && npm i -D @types/bun
npx tsc --noEmit      # strict typecheck
bun test              # 48 unit tests (store, nudge, persistence, ui, factory surface)
```

Tests are hermetic. They use pure state machines. They use temp-dir
persistence. They use fake `pi` surfaces that fire `agent_settled`
end-to-end. No pi install or API keys are needed.

## Architecture

```
src/
  store.ts         pure todo-list state machine — statuses, phases, promotion,
                   duplicate rejection, single in_progress invariant
  nudge.ts         pure decisioning — evaluateNudge (progress/activity/cooldown/
                   exhaustion gates) + reminder shaping + prompt appendix
  persistence.ts   session-keyed list files, atomic writes, structural validation
  ui.ts            pure TUI formatting — themed list view, progress bar, stats
                   (no pi imports; unit-testable without a terminal)
  dashboard.ts     fullscreen /tasks panel component (cached-state render:
                   no IO inside render(), so streaming never repaints it)
  index.ts         the factory — registers the tool, command, widget/status,
                   render hooks, nudge events, and message renderer
```

Design rule: everything below `index.ts` is pure and side-effect-free.
`index.ts` is the only file that talks to pi.

## Limitations

- Nudges fire only in interactive sessions where extensions receive
  `agent_settled`. Headless one-shot runs settle once and exit.
- One list per session. Parallel workstreams need separate sessions. This is
  deliberate. One checklist prevents the model from ignoring the remaining
  work.
- The nudge cannot force a model to obey. After the exhaustion cap, it stops.
  It tells *you* the tasks are stuck.
- Item identity is verbatim text. The duplicate guard rejects collisions up
  front. Two genuinely-different tasks still need distinct wordings.

## License

MIT.
