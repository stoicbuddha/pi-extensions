# Pi Loop Detector

This repo implements the loop detector plan as a small plugin package plus a reusable runtime core.

## Included

- Rolling event buffer with compact retained state
- Deterministic heuristics for suspicious repeated behavior
- Evidence packet generation sized for isolated judge-model calls
- Deterministic intervention handling after judge output
- Cooldown and early-clear behavior
- Node tests covering positive, negative, and recovery paths

## Usage

```js
import { LoopDetector } from "./src/index.js";

const detector = new LoopDetector({
  judge: async (evidence) => ({
    is_loop: true,
    confidence: 0.92,
    reason: "Repeated wrong tool call with no progress",
    recommended_action: "steer",
    offendingTool: evidence.normalizedSummary.offendingTool,
  }),
});

await detector.handleEvent({
  type: "assistant_message",
  content: "I should call `ralph_done` now.",
});

const outcome = await detector.handleEvent({
  type: "tool_call",
  toolName: "rollback_status",
  args: { id: 1 },
});

if (outcome?.intervention) {
  console.log(outcome.intervention.message);
}
```

## Notes

- The detector uses only stable runtime signals from the plan: messages, tool calls, tool results, failures, and normalized arguments.
- The judge never executes interventions directly; it only returns structured advice.
- Enforcement stays deterministic in the host runtime.
