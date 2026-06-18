---
name: pi-loop-detector
description: Detect suspicious looping behavior from assistant messages, tool calls, and tool results, then recommend deterministic interventions. Use when an agent appears stuck repeating the same wrong action pattern.
---

# Pi Loop Detector

Use this extension when you need to classify whether recent agent behavior looks like a loop.

## Available Tool

`detect_loop` analyzes a compact event list and returns:

- which heuristic fired
- a normalized evidence packet
- a judge-style structured outcome
- a deterministic intervention recommendation

## Event Format

Provide events in time order:

```json
[
  { "type": "assistant_message", "content": "I should call `ralph_done` now." },
  { "type": "tool_call", "toolName": "rollback_status", "args": {} },
  { "type": "tool_result", "toolName": "rollback_status", "args": {}, "ok": false, "result": "failed" }
]
```

## What It Detects

- repeated calls to the same tool without progress
- repeated mismatch between stated intent and actual tool call
- repeated tool failures with materially similar inputs
- repeated self-correction text followed by the same wrong action

## Interventions

The extension keeps enforcement deterministic. It recommends one of:

- `ignore`
- `steer`
- `pause`
- `restrict_tools`

Host runtime code should decide how to apply that recommendation.
