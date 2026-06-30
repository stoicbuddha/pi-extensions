# Ralph, Loop Detection, and Subagent Delegation Notes

## Current read

- `pi-ralph-wiggum` is the long-running loop controller.
- `pi-subagents` is the delegation substrate.
- `pi-loop-detector` is the policy layer that decides whether a turn is healthy, should stop, or should be rerouted.

The working direction is:

- keep loop detection reusable, but make Ralph the only place where doom-loop handling actively routes work
- prefer delegation to `scout`, `researcher`, `oracle`, and `reviewer` when the main agent is drifting or broadening scope
- keep `detect_loop` as a compatibility entrypoint, but do not let the current session perform in-session self-judgment
- treat `pi-subagents` as optional fallback infrastructure, not a hard dependency for basic loop detection
- make `newSession` the preferred Ralph recovery path once the supported Pi API flow is wired up cleanly

## Behavioral goal

When Ralph sees a likely doom loop:

- pause the current turn
- choose a child agent or a small child chain
- move broad recon/research/review work off the parent session
- avoid repeated in-session evaluation of the same loop state

Task metadata should also stay compact:

- keep task titles short
- store the real context in `details`
- show details in task preview/list views so titles do not need to encode the whole job

## Open question: cache behavior

There are several kinds of caching in the surrounding codebase, but they are not the same thing as a hidden semantic memory:

- token usage can report `cacheRead` / `cacheWrite`
- subagent tooling caches metadata, paths, and status reads for performance
- loop-related tooling can cache file or status lookups

That does not by itself prove a cross-session prompt-memory cache.

The current hypothesis is:

- the hallucinated loop diagnosis is more likely coming from session/context injection, resume behavior, or upstream wrapper state
- a provider-side prompt cache could make repeated prompt fragments cheaper, but it should not invent new factual loop history on its own

## Runtime compatibility note

The current Ralph implementation already has a `newSession` branch in the iteration dispatcher, but the exact supported Pi API shape needs to be verified against the updated runtime before we rely on it as the default recovery path.

Observed failure:

- `TypeError: ctx.newSession is not a function`

That means the merge plan should treat fresh-session recovery as a compatibility-sensitive path, but now with `newSession` as the preferred target:

- prefer `newSession` when the runtime supports the corrected flow
- keep a supported fallback path available when `newSession` cannot be used
- do not assume fresh-session creation works just because the code compiles
- verify the exact Pi runtime API before finalizing the implementation

## What to verify next

- whether the active Pi CLI path is resuming from a persisted session or injected prompt state
- whether the loop prompt is being re-sent by Ralph or another wrapper before the visible turn
- whether the relevant session was created with fresh context or a resumed parent transcript
- whether any prompt-template or session-rewrite layer is adding loop-detection language before the model responds

## Decision summary

- Shared core + wrappers
- Ralph-only doom-loop handling
- Delegation-first on loop risk
- Optional `pi-subagents`
- `newSession` preferred for Ralph recovery when supported
- Preserve `detect_loop` for compatibility
