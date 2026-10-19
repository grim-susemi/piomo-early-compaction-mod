# Continuity parity: builtin threshold route vs mod-style precomputed apply

Date: 2026-10-19
Worktree: `piomo-early-compaction-mod-wt/wave-3` (branch `early-compaction/wave-3`)
Plan: todo 10 of `overlay-early-compaction-mod`
Closes: GAP-7, IS-3 (continuity part)

## Question

A precomputed compaction applied through `ctx.applyCompaction` skips the core
`session_before_compact` hook (`agent-session.js:6461-6473` only emits it when
`request.precomputed` is undefined). That hook is where the builtin captures a
checkpoint and a todo snapshot (`BC/index.js:282-301,571,701`). The builtin's
own threshold route also applies a precomputed result through
`ctx.applyCompaction` (`BC/index.js:469,503` -> `speculative.js:319-341`).
Does the mod's direct precomputed apply therefore produce the same continuity
state as the builtin threshold route, or does it need extra continuity code?

## Method

`qa/session-kit.ts` builds a real in-process `AgentSession` with a temporary
agent dir (`mkdtemp`, removed by `dispose()`), an in-memory session log, the
stock builtin extensions, one inline probe extension, and an offline provider
with scripted usage numbers. Each arm runs in its own subprocess because the
mod/OMO patch process-wide prototypes.

`qa/continuity.test.ts` runs three arms over one scripted conversation:

1. **builtin** - a 65k-token first response crosses the builtin threshold on the
   second prompt. The builtin compaction extension generates the summary and
   applies it through `ctx.applyCompaction` during `before_agent_start`
   (`reason: "extension"`, `origin: "core-route"`).
2. **mod** - after the first response, the kit calls the extension context's
   `ctx.applyCompaction` directly with the exact same `CompactionResult`
   (summary text, kept-entry position, `tokensBefore`, and `details`), then the
   second prompt runs. A deliberate stale apply (`expectedRevision - 1`) runs
   first.
3. **core** - `session.compact()` (/compact) drives the core route, which does
   emit `session_before_compact`, persist a checkpoint and todo snapshot, and
   attach the restoration directive to the next prompt.

The conversation carries `TODO-CONTINUITY-42` in the first prompt and in the
scripted summary. The next provider request is the request for the second
prompt; entries are read from the in-memory session manager.

Holding the `CompactionResult` (including details) constant isolates the apply
route. The production mod's details schema comes from todos 7/11; those details
are not continuity-bearing, so they are not what this experiment varies.

## Result

`bun test qa/continuity.test.ts` -> exit 0, 1 pass.

- Next-request messages, normalized only for the standard
  `<environment_context>...</environment_context>` preamble: **equal**.
- Entries, excluding the standard `environment-context` custom message: **equal**
  (same order, roles, text, compaction summary, kept-entry index, `tokensBefore`,
  details).
- Todo text: **equal**; both next requests contain
  `- TODO-CONTINUITY-42: verify that the todo list survives compaction.`
- Restoration directive: **equal** (absent in both precomputed arms).
- Checkpoint / todo-snapshot entries: **equal** (absent in both precomputed arms).
- Stale apply: `{ applied: false, reason: "stale" }`, entries delta **0**;
  the subsequent valid apply returns `{ applied: true, reason: "ok" }` and writes
  exactly one compaction entry.
- Core arm: one `session_before_compact` event (`reason: "manual"`), a
  `compaction.agent-checkpoint` entry, a `compaction.todo-snapshot` entry, and
  the restoration directive in the next request.

Raw comparison: the precomputed arms differ by exactly the standard environment
context (see accepted difference 2). The continuity payloads are identical, so
**no continuity code is needed**.

## Accepted differences

### 1. Core-route restoration directive (expected, core-only)

Only core-route compactions emit `session_before_compact` and therefore capture
the checkpoint and todo snapshot (`BC/index.js:571,701`). On the next
`before_agent_start`, `attachRestorationDirective` adds the directive
`[restore checkpointed session agent configuration after compaction]` when the
latest checkpoint is at most 60 seconds old (`BC/index.js:762`,
`extension-wiring.js:45-50`, `checkpoint-state.js:4,110,144`). Manual `/compact`,
pre-prompt and overflow compactions get this; the builtin threshold route and the
mod's precomputed apply do not. The core arm proves this difference is real and
confined to core routes. This is an accepted difference; the mod must not add a
checkpoint/todo capture for the threshold route.

### 2. Environment context re-injection when the apply precedes the prompt

Exact raw diff: in the mod arm the second prompt's provider message is prefixed
with

```
<environment_context>
  <cwd>C:/Users/USER/orca/projects/piomo-early-compaction-mod-wt/wave-3</cwd>
  <current_date>2026-10-19</current_date>
</environment_context>
```

and the session has one extra `custom_message` / `environment-context` entry
after the compaction entry. The builtin arm applies during the same prompt's
`before_agent_start`, after the prompt's environment-context decision was made,
so it does not re-inject. The mod arm applies before the prompt; the
post-compaction projection no longer contains the old environment-context
message, so the SDK re-injects the current one.

This is a timing artifact of the apply point, not continuity data: it contains
no todo, checkpoint, restoration, task intent, or summary text. The experiment
therefore compares continuity payloads after stripping this standard preamble and
records the raw difference here. No product code is written for it.

## Failure QA

An apply with an outdated `expectedRevision` returns
`{ applied: false, reason: "stale" }` at `agent-session.js:6312-6313` before any
entry is appended. The arm asserts an entries delta of 0; the valid apply that
follows writes exactly one compaction entry.

## Conclusion

**Continuity parity is PROVEN for the builtin threshold route and a mod-style
precomputed apply**: todo text, summary, kept messages, compaction entry, and the
absence of checkpoint/todo restoration payloads are identical. The only raw
difference between the two precomputed arms is the standard environment-context
re-injection (a timing artifact); the core-route restoration directive is the
separate, expected core-only difference. No continuity code is needed in the mod.

Limitations: one offline fixture, one scripted conversation, in-memory sessions;
no real model and no live agent dir. The baseline exercised is the blocking
threshold route (`BC/index.js:503`) during `before_agent_start`. The idle warm-up
apply (`BC/index.js:204`) uses the same precomputed `ctx.applyCompaction` seam but
was not exercised: it requires `tui`/`rpc` mode and a speculative job that
outlives the turn, which the offline provider's immediate response does not
reproduce.
