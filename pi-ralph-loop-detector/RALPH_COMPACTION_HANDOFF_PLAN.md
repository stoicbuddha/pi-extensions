# Ralph Compaction Handoff Plan

Date: 2026-07-03
Workspace: `/home/matt/Sites/pi-extensions`
Primary package: `/home/matt/Sites/pi-extensions/pi-ralph-loop-detector`

## Goal

Replace Pi compaction behavior during active Ralph loops with a fresh-context handoff flow that:

1. Cancels compaction when a Ralph loop is active.
2. Produces a bounded, structured handoff summary.
3. Starts a fresh session using the supported `newSession()` command-context API.
4. Preserves Ralph loop continuity without relying on Pi compaction summaries.

## Why

Current failure mode:

- Pi compacts during a Ralph loop.
- Compaction can happen repeatedly.
- Repeated compaction interacts badly with the looping failure pattern.
- The model can lose momentum and continue the same bad cycle after compaction.

Desired replacement:

- Treat compaction pressure as a signal to rotate to a fresh provider context.
- Use Ralph canonical state plus a recent transcript slice to build a handoff.
- Resume the loop in a new session seeded with explicit recovery instructions.

## Confirmed Constraints

These are verified against the installed Pi docs/types in `pi-transcript-review/node_modules/@earendil-works/pi-coding-agent/`.

### Compaction hook capabilities

- `session_before_compact` is cancellable.
- `session_before_compact` may also provide a custom compaction summary.
- Source:
  - `docs/extensions.md`
  - `docs/compaction.md`
  - `dist/core/extensions/types.d.ts`

### Session replacement limitations

- `ctx.newSession()` is available on `ExtensionCommandContext`, not plain `ExtensionContext`.
- `session_before_compact` handlers receive plain `ExtensionContext`.
- Pi explicitly documents `newSession()` as command-only because event-handler use can deadlock.

### Safe self-trigger pattern

- Extensions can queue a follow-up user message with `pi.sendUserMessage(..., { deliverAs: "followUp" })`.
- That pattern can be used to invoke an extension command later from a safe command context.

### Ralph-specific current behavior

- Ralph already supports fresh-session dispatch when running in a command-capable context.
- Current recovery flow already builds analysis and recovery prompts via isolated subagent logic.
- `ralph_done` is a tool, not a slash command.

## Non-Goals

- Do not patch Pi core for this first iteration.
- Do not rely on storing stale context objects globally.
- Do not summarize the entire session transcript.
- Do not couple the handoff to fake tool invocation text such as synthetic `ralph_done` calls.

## High-Level Design

Use a two-phase flow.

### Phase 1: compaction interception

When `session_before_compact` fires and a Ralph loop is active:

1. Detect active Ralph loop.
2. Build a compact evidence bundle for handoff generation.
3. Persist a pending handoff record in Ralph state.
4. Return `{ cancel: true }` to skip compaction.
5. Queue a follow-up extension command using `pi.sendUserMessage("/ralph-handoff-now ...", { deliverAs: "followUp" })`.

This phase must not call `newSession()` directly.

### Phase 2: safe handoff execution

When `/ralph-handoff-now` runs in command context:

1. Re-load the latest Ralph state.
2. Read the persisted pending handoff record.
3. Refuse duplicate dispatch if already consumed.
4. Call `ctx.newSession(...)`.
5. In `withSession`, send:
   - Ralph reset/iteration prompt
   - generated handoff summary
   - explicit next-step instructions
6. Mark the pending handoff as consumed.

## Architecture Changes

## 1. Add explicit handoff state to Ralph loop storage

Add persisted fields to loop state in `ralph-tools.js`:

- `pendingHandoff`: boolean
- `pendingHandoffReason`: `"compaction"` | `"recovery"` | null
- `pendingHandoffPrompt`: string | null
- `pendingHandoffCreatedAt`: ISO timestamp | null
- `pendingHandoffGeneration`: number
- `lastHandoffDispatchedGeneration`: number

Purpose:

- dedupe repeated compaction events
- avoid enqueueing multiple handoff commands
- allow safe recovery after reload/restart

## 2. Extract a shared handoff summary builder

Create a shared function, likely near existing recovery helpers:

- `buildRalphHandoffEvidence(ctx, loop, options?)`

Inputs:

- active loop state
- canonical plan/task state
- recent transcript slice
- recent loop detector evidence if available
- most recent recovery analysis if available

Output:

- structured JSON-serializable evidence object

The evidence should prioritize:

1. Ralph canonical state
2. Current task / next task
3. Recent transcript window
4. Recent failure pattern

## 3. Reuse subagent-based recovery summarization for handoff

Extend the existing subagent summary path rather than inventing a separate mechanism.

Candidate approach:

- reuse `evaluateRecoverySummaryWithSubagent(...)`
- or add a sibling helper specialized for compaction handoff summarization

Expected output:

- `summary`
- `next_steps`
- `rationale`
- `suspected_goal`
- `offendingTool`

Then turn that into a handoff prompt with a dedicated formatter:

- `buildCompactionHandoffPrompt(loop, analysis, evidence)`

This should differ from the current loop-recovery prompt in one key way:

- it assumes a planned fresh session rotation, not just “loop detected, recover somehow”

## 4. Extract a shared fresh-context dispatcher

Create an internal primitive that performs fresh-session dispatch once a valid command context exists:

- `dispatchRalphFreshContext(ctx, loop, prompt, metadata?)`

Responsibilities:

- call `ctx.newSession(...)`
- pass `parentSession`
- send the prompt in `withSession`
- report success/failure
- update loop state / diagnostics

This should become the common primitive used by:

- normal Ralph fresh iteration dispatch
- future compaction-replacement handoff
- possibly loop-recovery dispatch if we want one unified path later

## 5. Add a dedicated extension command

Register:

- `/ralph-handoff-now [loop]`

Responsibilities:

- resolve target loop
- verify pending handoff exists
- no-op if already dispatched
- call `dispatchRalphFreshContext(...)`
- clear or advance handoff generation markers on success

This command is the safe bridge between compaction cancellation and `newSession()`.

## 6. Intercept compaction in the extension entrypoint

In `index.ts`, add a `session_before_compact` handler for the merged Ralph detector package.

Behavior:

1. If no active Ralph loop, do nothing.
2. If handoff already pending for current generation, return `{ cancel: true }`.
3. Build handoff evidence.
4. Generate or refresh the handoff prompt.
5. Persist pending handoff state.
6. Queue `/ralph-handoff-now <loop>` as follow-up.
7. Return `{ cancel: true }`.

Important:

- This hook should be conservative.
- If evidence building or handoff generation fails, choose one fallback explicitly:
  - fallback A: allow normal compaction
  - fallback B: cancel compaction and queue a minimal handoff prompt

Recommended first version:

- If we cannot build a handoff prompt at all, allow normal compaction rather than risking deadlock or no-progress behavior.

## Data Selection for Handoff

Do not use the whole transcript.

Recommended handoff bundle:

- Ralph loop name
- iteration
- max iterations
- session strategy
- current task id
- top 1-3 active tasks
- recent loop notes / evidence
- recent reflections
- last recovery analysis, if any
- recent user messages: last 2-4
- recent assistant messages: last 2-4
- recent tool calls/results around the current failure window
- detected offending tool / trigger, if any

Budget target:

- keep the serialized evidence comfortably bounded
- optimize for “enough to continue” rather than “everything that happened”

## Suggested Prompt Shape

Fresh-session user message should contain:

1. Ralph loop framing
2. structured handoff summary
3. explicit next steps
4. explicit anti-loop guidance

Draft shape:

```md
[RALPH LOOP RESET]

You are continuing Ralph loop "<name>" at iteration <n>.

Do not assume the old transcript is available.
Use Ralph canonical state as source of truth.

## Handoff Summary
...

## Current Task Focus
...

## Known Failure Pattern
...

## Next Steps
1. ...
2. ...

Do not repeat the same failed action.
Start with the narrowest validating step.
Use Ralph tools to keep canonical state current.
```

## Relationship to `ralph_done`

Do not invoke `ralph_done` to trigger this flow.

Reason:

- `ralph_done` semantically advances the iteration.
- compaction handoff is a context-rotation event, not necessarily iteration completion.

Instead:

- factor shared fresh-context dispatch into an internal helper
- let `ralph_done` and compaction handoff both call that helper if appropriate
- keep iteration advancement separate from session rotation

This separation avoids incorrect loop-state transitions.

## Failure Handling

### If handoff command queueing fails

- log diagnostic state
- allow fallback to normal compaction in the next attempt

### If `/ralph-handoff-now` runs but `newSession()` fails

- keep the pending handoff record
- optionally fall back to a standard follow-up prompt in the existing session
- notify the user in UI when available

### If duplicate compaction events fire

- use generation counters and `pendingHandoff` gating
- avoid emitting multiple queued commands

### If the session reloads mid-flow

- rehydrate pending handoff state from `.ralph`
- allow the next safe command context to resume dispatch

## Logging / Debugging

Add loop events for:

- `compaction_handoff_prepare`
- `compaction_handoff_queued`
- `compaction_handoff_dispatch`
- `compaction_handoff_dispatch_failed`
- `compaction_handoff_cleared`

This should be recorded in Ralph loop events, not just transient UI messages.

## Implementation Steps

1. Add persisted pending-handoff fields to Ralph loop state.
2. Extract shared fresh-context dispatch helper.
3. Extract handoff evidence builder.
4. Reuse or extend subagent summary generation for handoff summaries.
5. Add `/ralph-handoff-now`.
6. Add `session_before_compact` interception in `index.ts`.
7. Wire dedupe and generation guards.
8. Add tests.

## Test Plan

### Unit tests

- handoff evidence builder returns bounded structured payload
- handoff prompt formatter includes current task and anti-loop guidance
- duplicate compaction events do not queue duplicate handoffs
- pending handoff state persists and reloads correctly

### Integration-style tests

- active Ralph loop + `session_before_compact` => returns cancel and queues handoff command
- `/ralph-handoff-now` calls `newSession()` and sends prompt
- failed `newSession()` preserves pending handoff state
- normal non-Ralph compaction remains unchanged

### Manual verification

1. Start a Ralph loop with `sessionStrategy: newSession`.
2. Force context pressure near compaction threshold.
3. Verify compaction is cancelled.
4. Verify handoff command is queued once.
5. Verify fresh session starts with Ralph reset prompt plus generated handoff.
6. Verify loop state remains active and iteration number is unchanged unless `ralph_done` was explicitly used.

## Open Questions

1. Should compaction-triggered handoff reuse the exact same prompt builder as loop recovery, or have a dedicated formatter?
2. On handoff-generation failure, should we:
   - allow normal compaction
   - or use a minimal fallback handoff prompt and still cancel compaction?
3. Should a successful compaction-triggered handoff set `pendingSessionReset`, or should that remain reserved for iteration transitions only?
4. Do we want to unify compaction-handoff and loop-recovery fresh-session dispatch immediately, or keep them separate in v1?

## Recommended Default Answers

1. Use a dedicated formatter, but reuse the same subagent summary schema.
2. Allow normal compaction if handoff generation completely fails in v1.
3. Keep `pendingSessionReset` separate from compaction handoff state.
4. Share the low-level `dispatchRalphFreshContext(...)` primitive, but keep higher-level flows separate in v1.

## Recommended First PR Scope

Keep the first implementation narrow:

- add pending handoff persistence
- add `/ralph-handoff-now`
- add compaction interception
- build handoff summary from existing recovery-summary subagent path
- dispatch fresh session from the command

Do not try to redesign all Ralph recovery paths in the same change.
