# Pi Loop Detector

This repo implements the loop detector plan as a small plugin package plus a reusable runtime core.

Deprecated in favor of the merged `pi-ralph-loop-detector` package at the monorepo root. Keep this around only for compatibility and low-risk reuse.

## Included

- Rolling event buffer with compact retained state
- Deterministic heuristics for suspicious repeated behavior
- Evidence packet generation sized for isolated subagent judge calls
- Judge bridge that offloads loop review to a separate `pi` subprocess and returns `continue`, `stop`, or `steer`
- Sticky halt handling until reset
- Node tests covering positive, negative, and recovery paths

## Usage

```js
import { LoopDetector } from "./src/index.js";

const detector = new LoopDetector({
  judge: async (evidence) => ({
    confidence: 0.92,
    action: "steer",
    steer_message: "Please try a different tool.",
  }),
});

const outcome = await detector.handleEvent({
  type: "tool_call",
  toolName: "rollback_status",
  args: { id: 1 },
});

if (outcome?.judgeOutcome.action === "steer") {
  console.log(outcome.judgeOutcome.steer_message);
}
```

## Notes

- The detector uses only stable runtime signals from the plan: messages, tool calls, tool results, failures, and normalized arguments.
- The judge bridge should be isolated from the parent transcript and should return structured JSON.
- `steer` is a detector output, not a request to judge the current session in place.
- `stop` is sticky in the host runtime until an explicit reset.

## Optional Project Config

Create `.pi-loop-detector.json` in a project root to tune generic detection for local tools. The config is optional; defaults stay generic and pattern-based.

```json
{
  "version": 1,
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
