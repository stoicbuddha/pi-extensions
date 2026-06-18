# Loop Checker Plan

## Goal

Detect agent loop behavior early and intervene before the model burns turns repeating the same wrong action pattern.

This plan is intended for a separate extension, not Ralph itself.

## Problem Shape

The failure mode to target is not just "many tool calls." It is repetitive, nonproductive behavior such as:

- repeated calls to the same tool with no progress
- repeated mismatch between stated intent and actual tool call
- repeated self-correction text followed by the same wrong action
- repeated tool failures with no strategy change

## Recommended Architecture

Use a two-stage detector:

1. deterministic heuristics
2. isolated judge-model evaluation

The deterministic stage should decide when behavior is suspicious enough to escalate.
The judge-model stage should review a compact evidence packet in a clean context and recommend an intervention.

## Observable Signals

Build the detector from stable runtime signals:

- assistant message text
- tool execution start / end
- tool names
- tool arguments
- tool results
- repeated failures

Do not rely on hidden reasoning as the primary signal, even if some thought-like content is visible.

## Core Heuristics

Start with a small ruleset:

### Rule A: Same Tool Repetition

Trigger if the same tool is called `N` times in the last `M` actions with no evidence of progress.

Example defaults:

- `N = 3`
- `M = 5`

### Rule B: Intent / Action Mismatch

Trigger if assistant text clearly states an intended tool, but the next actual tool call is different.

Example patterns:

- "I should call `ralph_done`"
- "Let me call `ralph_done` now"

This should require at least 2 mismatches before escalation to avoid false positives.

### Rule C: Failure Repetition

Trigger if the same tool fails repeatedly with materially similar inputs and the assistant does not change approach.

### Rule D: Self-Correction Loop

Trigger if the assistant repeatedly says some form of:

- "I keep doing the wrong thing"
- "I need to stop calling X"
- "Let me correct that"

and then repeats the same wrong tool action.

## Evidence Packet

When a heuristic fires, build a compact evaluation packet containing:

- last `K` assistant messages
- last `K` tool calls
- last `K` tool results
- a normalized event summary
- which heuristic fired

Recommended initial `K`:

- `6` to `10` events

Example normalized summary:

```json
{
  "trigger": "intent_action_mismatch",
  "expected_tool": "ralph_done",
  "actual_tool_sequence": [
    "rollback_status",
    "rollback_status",
    "rollback_status"
  ],
  "notes": [
    "assistant stated ralph_done twice",
    "no successful corrective action observed"
  ]
}
```

## Judge Model Call

The judge call should run in an isolated context with only:

- system instructions for loop classification
- the compact evidence packet
- a request for structured output only

Suggested output schema:

```json
{
  "is_loop": true,
  "confidence": 0.91,
  "reason": "Repeated intent/action mismatch with same wrong tool",
  "recommended_action": "steer"
}
```

Allowed `recommended_action` values:

- `ignore`
- `steer`
- `pause`
- `restrict_tools`

## Interventions

Keep intervention logic deterministic after the judge returns.

### `steer`

Inject a concise steering message describing:

- what repeated pattern was observed
- what the next allowed action should be
- what action should not be repeated

### `pause`

Pause the active loop or stop automatic continuation until the user resumes.

### `restrict_tools`

If Pi makes this practical, reduce available tools temporarily or block the repeated offender for one turn.

### `ignore`

Record the evaluation and do nothing.

## Cooldown

Add a cooldown so the detector does not fire repeatedly while the model is trying to recover.

Recommended initial behavior:

- after intervention, ignore new triggers for the next `2` to `4` assistant/tool events
- clear cooldown early if the model takes a clearly different action

## State Tracking

Maintain a small rolling window in extension state:

- recent assistant messages
- recent tool calls
- recent tool results
- active cooldown
- last intervention type
- last judge outcome

If persistence is useful across reloads, store compact event summaries rather than raw transcripts.

## Safety Constraints

- Never let the judge model directly execute the intervention.
- Never trust self-diagnosis from the in-loop agent as the primary detector.
- Keep the extension in charge of thresholds, escalation, and enforcement.
- Cap evidence size so the judge call stays cheap and focused.

## Testing Plan

### Positive Cases

- repeated identical wrong tool calls
- repeated intent/action mismatch
- repeated failure loops

### Negative Cases

- valid repeated tool use during legitimate workflows
- retries after meaningful changes to arguments
- multi-step workflows that naturally use the same tool several times

### Recovery Cases

- model corrects itself after steer message
- cooldown prevents intervention spam
- pause path stops the loop cleanly

## Recommended Implementation Order

1. Capture message and tool events into a rolling buffer.
2. Implement deterministic heuristics only.
3. Add logging / debug output to tune thresholds.
4. Add the isolated judge call.
5. Add deterministic intervention handling.
6. Add cooldown behavior.
7. Tune thresholds against real loop transcripts.
