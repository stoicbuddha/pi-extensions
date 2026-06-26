---
name: pi-loop-detector
description: Detect suspicious looping behavior from assistant messages, tool calls, and tool results, then route the result through a subagent judge. Use when an agent appears stuck repeating the same wrong action pattern.
---

# Pi Loop Detector

Use this extension when you need to classify whether recent agent behavior looks like a loop.

## Available Tool

- which heuristic fired
- a normalized evidence packet
- a loop review object with `confidence`, `action: "continue" | "stop" | "steer"`, and optional `steer_message`
- a sticky halt state until reset when the judge returns `stop`

## What It Detects

- repeated calls to the same tool without progress
- repeated mismatch between stated intent and actual tool call
- repeated tool failures with materially similar inputs
- repeated self-correction text followed by the same wrong action

## Interventions

Host runtime code should apply the judge result deterministically:

- `continue`: let the parent session proceed
- `stop`: enter a sticky halted state until reset
- `steer`: inject the returned `steer_message` directly into the parent session
