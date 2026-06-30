---
name: loop-detector
description: Use the loop detector core in this plugin to capture runtime events, classify suspicious repetition, build judge-ready evidence packets, and return subagent-friendly loop decisions.
disable-model-invocation: false
---

# Loop Detector

Deprecated in favor of the merged Ralph-centric package. This skill remains as a compatibility surface for the underlying detector core.

Use this plugin when an agent runtime needs to detect repeated nonproductive behavior before it burns more turns.

## What It Implements

- Rolling event buffer for assistant messages, tool calls, and tool results
- Deterministic heuristics for:
  - same-tool repetition
  - intent/action mismatch
  - repeated failures with similar inputs
  - self-correction loops
- Compact evidence packet generation
- Judge output normalization for `continue`, `stop`, and `steer`
- Sticky halted state support in the host runtime

## Runtime Contract

Feed events into `LoopDetector.handleEvent()` using these shapes:

```js
{ type: "assistant_message", content: "I should call `ralph_done` now." }
{ type: "tool_call", toolName: "rollback_status", args: { id: 1 } }
{ type: "tool_result", toolName: "rollback_status", args: { id: 1 }, ok: false, result: "failed" }
```

When a trigger fires, `handleEvent()` returns:

```js
{
  trigger,
  evidence,
  judgeOutcome,
  intervention
}
```

`judgeOutcome.action` is normalized to `continue`, `stop`, or `steer`. Host runtime code should treat `steer` as a steer request coming back from the judge, not as permission to re-judge the current session in place. The judge itself should run out-of-process; `stop` remains sticky until reset.

## Judge Contract

Provide an async `judge(evidence)` callback if you want isolated model review. Return:

```js
{
  confidence: 0.95,
  action: "steer", // "continue" | "stop" | "steer"
  steer_message: "Please try a different tool."
}
```

If no judge is provided, the detector fails closed rather than inventing a local loop decision.
