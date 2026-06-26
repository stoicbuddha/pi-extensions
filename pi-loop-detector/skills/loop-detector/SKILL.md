---
name: loop-detector
description: Use the loop detector core in this plugin to capture runtime events, classify suspicious repetition, build judge-ready evidence packets, and return deterministic interventions.
disable-model-invocation: false
---

# Loop Detector

Use this plugin when an agent runtime needs to detect repeated nonproductive behavior before it burns more turns.

## What It Implements

- Rolling event buffer for assistant messages, tool calls, and tool results
- Deterministic heuristics for:
  - same-tool repetition
  - intent/action mismatch
  - repeated failures with similar inputs
  - self-correction loops
- Compact evidence packet generation
- Optional isolated judge callback with structured output
- Deterministic interventions: `ignore`, `steer`, `pause`, `restrict_tools`
- Cooldown logic to avoid intervention spam

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

Use `intervention.message` as the steering or pause text exposed to the in-loop agent. Keep actual enforcement in the host runtime.

## Judge Contract

Provide an async `judge(evidence)` callback if you want isolated model review. Return:

```js
{
  confidence: 0.95,
  action: "steer", // "continue" | "stop" | "steer"
  message: "Please try a different tool." // optional
}
```If no judge is provided, the detector defaults to deterministic `steer` behavior after a heuristic fires.
