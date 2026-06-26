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
    confidence: 0.92,
    action: "steer",
    message: "Please try a different tool.",
  }),
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

## Optional Project Config

Create `.pi-loop-detector.json` in a project root to tune generic detection for local tools. The config is optional; defaults stay generic and pattern-based.

```json
{
  "version": 1,
  "recoveryMode": "steer",
  "toolAliases": [
    { "match": "^(?:ToolKitMCP|ToolkitMCP|Toolkit MCP)_(.+)$", "replace": "$1" }
  ],
  "toolClasses": [
    { "match": "(status|list|show|read|search|inspect|view|cat|ls)$", "class": "read" },
    { "match": "(create|append|write|edit|replace|remove|delete|commit|restore|apply)", "class": "write" },
    { "match": "(check|test|validate|lint|clippy|build|fmt|doc)", "class": "validate" },
    { "match": "(clean|clear|prune|cache)", "class": "cleanup" }
  ],
  "classes": {
    "read": { "successCountsAsProgress": false, "sameCycleRepeats": 3, "sameToolRepeats": 3 },
    "cleanup": { "successCountsAsProgress": false, "sameCycleRepeats": 3, "sameToolRepeats": 3 },
    "validate": { "successCountsAsProgress": "weak", "sameCycleRepeats": 3, "sameToolRepeats": 3 },
    "write": { "successCountsAsProgress": true, "sameCycleRepeats": 3, "sameToolRepeats": 3 },
    "unknown": { "successCountsAsProgress": "weak", "sameCycleRepeats": 3, "sameToolRepeats": 4 }
  },
  "tools": {
    "cargo_clean": {
      "class": "cleanup",
      "successCountsAsProgress": false,
      "sameCycleRepeats": 2
    },
    "apply_edit_plan": {
      "class": "write",
      "noProgressPatterns": [
        "real file changed:\\s*no",
        "candidate edit persisted:\\s*no",
        "write aborted"
      ]
    }
  },
  "resultPatterns": {
    "progress": ["rollback_id", "created", "updated", "modified", "files? changed", "committed"],
    "noProgress": ["no files? changed", "unchanged", "already up to date", "not executed", "redundant"],
    "failure": ["validation failed", "write aborted", "\"ok\"\\s*:\\s*false"]
  },
  "heuristics": {
    "assistantRepetition": { "enabled": true, "recentMessages": 8, "minRepeats": 4, "minNormalizedChars": 120 },
    "cycleRepetition": { "enabled": true, "recentEvents": 24, "minRepeats": 3, "minAssistantChars": 80 },
    "selfCorrection": { "enabled": true, "minCorrections": 3, "minRepeatedCalls": 3 },
    "sameTool": { "recentActions": 5, "minRepeats": 3, "maxDistinctArgs": 1 },
    "failureRepetition": { "minFailures": 3, "lookbackResults": 6 }
  }
}
```

### Fields

- `toolAliases`: regex replacements applied before classification. Use this to strip MCP server prefixes.
- `recoveryMode`: `steer` (default) sends an in-session steering prompt when a loop is detected. `newSession` starts a separate fresh recovery session, which is useful for severe loops but creates an additional provider request.
- `toolClasses`: ordered regex rules that assign a normalized tool name to a class.
- `classes`: default behavior per class.
- `tools`: exact per-tool overrides after alias normalization.
- `resultPatterns`: regexes for interpreting tool output as progress, no progress, or failure.
- `heuristics`: threshold overrides. These map onto the detector's built-in heuristic config.

Exact `tools` entries win over `toolClasses`. Result patterns can override class defaults: failure beats no-progress, no-progress beats success, and explicit progress beats weak success.

### Tuning Guidance

Tune stricter when tools are cheap and often loop-prone:

```json
{
  "classes": {
    "read": { "successCountsAsProgress": false, "sameCycleRepeats": 2, "sameToolRepeats": 2 },
    "cleanup": { "successCountsAsProgress": false, "sameCycleRepeats": 2, "sameToolRepeats": 2 }
  }
}
```

This catches repeated status/list/search/cleanup cycles quickly.

Tune looser when the model should get more room to recover on its own:

```json
{
  "heuristics": {
    "assistantRepetition": { "minRepeats": 5, "minNormalizedChars": 180 },
    "cycleRepetition": { "minRepeats": 4 },
    "selfCorrection": { "minCorrections": 4, "minRepeatedCalls": 4 }
  },
  "classes": {
    "read": { "sameCycleRepeats": 4, "sameToolRepeats": 4 },
    "cleanup": { "sameCycleRepeats": 4, "sameToolRepeats": 4 }
  }
}
```

This is useful when the model is often able to talk itself out of a bad approach after one or two failed attempts.

Tune looser when a workflow legitimately repeats similar actions:

```json
{
  "tools": {
    "screenshot_url": { "class": "read", "sameCycleRepeats": 4, "sameToolRepeats": 5 }
  }
}
```

This is useful for UI work where repeated screenshots after visible changes are normal.

Mark successful tools as non-progress when `ok: true` only means "the command ran":

```json
{
  "tools": {
    "cargo_clean": { "class": "cleanup", "successCountsAsProgress": false }
  }
}
```

Mark tool-specific no-progress messages when an edit tool can reject a candidate without changing files:

```json
{
  "tools": {
    "apply_edit_plan": {
      "class": "write",
      "noProgressPatterns": ["real file changed:\\s*no", "candidate edit persisted:\\s*no"]
    }
  }
}
```

Use fresh recovery sessions only when you want the loop detector to isolate the judge/recovery prompt from the current transcript:

```json
{
  "recoveryMode": "newSession"
}
```

That can improve recovery quality for badly contaminated contexts, but it also means a detection event can launch a second provider task. Keep the default `steer` mode when prompt volume or local-model context pressure is the main concern.
