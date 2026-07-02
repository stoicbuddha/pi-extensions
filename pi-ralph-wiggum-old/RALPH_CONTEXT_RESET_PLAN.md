# Ralph Context Reset Plan

## Goal

Make each Ralph iteration start with a clean, relevant context instead of carrying forward the full prior loop transcript.

The target behavior is:

- keep the loop state and task file
- drop the prior iteration's noisy transcript
- start the next iteration with the current Ralph instructions and task content
- make this configurable per project / loop

## Recommended Strategy

Use a configurable session strategy with two initial modes:

- `followUp`
  - current behavior
  - queue the next Ralph iteration with `pi.sendUserMessage(..., { deliverAs: "followUp" })`
- `newSession`
  - after `ralph_done`, create a fresh session for the next iteration
  - seed that session with the minimal setup needed for the next loop turn

Do not attempt in-place mutation of the current session history. Use supported session replacement / creation behavior instead.

## Config Shape

Store the session strategy directly in loop state or the database, for example:

```json
{
  "sessionStrategy": "followUp",
  "sessionStrategyFailure": "followUp"
}
```

Recommended enum values:

- `followUp`
- `newSession`

Recommended failure-mode enum values:

- `followUp`
- `stopAndAlert`

This should be read at loop start and persisted into loop state so the behavior is stable for the lifetime of the loop.

## State Changes

Extend `LoopState` with:

```ts
sessionStrategy: "followUp" | "newSession";
sessionStrategyFailure: "followUp" | "stopAndAlert";
```

Potential follow-on field if needed later:

```ts
resetMarker?: boolean;
```

## Control Flow

### Start / Resume

1. Load the persisted loop state.
2. Resolve `sessionStrategy`.
3. Store it in loop state.
4. Keep current start / resume behavior for iteration 1 unless the implementation needs immediate session seeding.

### On `ralph_done`

1. Validate there is an active loop.
2. Increment iteration and persist state.
3. Read the latest task file contents.
4. Build the next iteration prompt from current state.
5. Branch on `sessionStrategy`:
   - `followUp`
     - keep current `pi.sendUserMessage(..., { deliverAs: "followUp" })`
   - `newSession`
     - wait until Pi is at a safe session-modification point
     - create a new session
     - seed the next loop iteration there

## Session Seeding Design

The new session should contain only the minimum useful context:

- normal Pi baseline setup
- Ralph loop identity
- current iteration number
- current task file path
- current task file contents
- optional short reset marker such as:
  - "Previous loop transcript intentionally discarded; continue from current task state."

The task file remains the durable source of truth for progress.

## Hooking Approach

Keep `before_agent_start` as the main place where Ralph injects iteration instructions.

That preserves the current architecture:

- loop state lives on disk
- runtime prompt is rebuilt on each agent start
- session resets do not need to preserve prior loop transcript

## Error Handling

If `newSession` creation fails:

1. inspect `sessionStrategyFailure`
2. if `followUp`
   - notify the user
   - keep the loop state intact
   - dispatch the next iteration with normal follow-up behavior
3. if `stopAndAlert`
   - notify the user prominently
   - pause or stop automatic continuation
   - keep loop state intact so the user can resume manually

Prefer explicit failure handling over silent fallback.

## Testing Plan

### Functional

- Start a loop with `sessionStrategy: "followUp"` and confirm current behavior is unchanged.
- Start a loop with `sessionStrategy: "newSession"` and confirm each `ralph_done` advances into a fresh session.
- Confirm the next iteration still sees the current task file contents.
- Confirm pause / resume still works.
- Confirm completion marker handling still works.

### Recovery

- Confirm session reload still rehydrates the active loop.
- Confirm compaction or manual session changes do not orphan the loop.
- Confirm failed session creation does not destroy loop state.

### UX

- Confirm the user can still interrupt between iterations.
- Confirm the fresh session contains enough context to act correctly without prior transcript.

## Risks

- Higher cold-start cost each iteration.
- Session switching may be more visible than follow-up messages.
- `newSession` may require careful handling around idle/safe lifecycle timing.
- If the seeded prompt is too thin, the agent may lose useful working context.

## Recommended Implementation Order

1. Add config loading for persisted loop settings.
2. Add `sessionStrategy` to `LoopState`.
3. Refactor next-iteration dispatch behind one function.
4. Keep `followUp` path as-is.
5. Add `newSession` path.
6. Test start, `ralph_done`, pause, resume, completion, and reload behavior.
