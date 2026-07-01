# Ralph Integration Status

Date: 2026-06-30
Workspace: `/home/matt/Sites/pi-extensions`

## Current State

The Ralph loop-detector integration is split across two trees:

- Current detector tree: `/home/matt/Sites/pi-extensions/pi-loop-detector`
- Deprecated Ralph tree: `/home/matt/Sites/pi-extensions/pi-ralph-loop-detector`

The runtime symptoms the user reported are coming from the deprecated Ralph tree, not the current detector tree.

## What I Verified

- The current detector tree no longer hard-codes a judge timeout.
- The deprecated Ralph tree still had a hard-coded 15s judge timeout and the older recovery prompt text.
- The old recovery prompt includes `Preferred child-agent order: scout -> researcher -> reviewer.`
- The user’s captured session logs under `~/.pi/agent/sessions/...` show the old Ralph recovery payload, so that tree is still being exercised.
- The installed `pi` exec path does not impose a 15s default timeout by itself; the timeout was coming from the Ralph plugin code.

## Changes Already Made

### In `/home/matt/Sites/pi-extensions/pi-loop-detector`

These changes were already present before the handoff request:

- Added exact repeated-payload loop detection in `src/loop-detector.js`.
- Added debug logging support and debug command handling in `index.ts` / `index.js`.
- Removed the hard judge timeout in `src/subagent-bridge.js` by making the default timeout `null`.
- Added a judge-activation notice when the bridge runs.
- Updated tests to match the new repeat-detection behavior.

### In `/home/matt/Sites/pi-extensions/pi-ralph-loop-detector`

I patched the deprecated Ralph tree directly so it matches the active runtime the user is seeing:

- `src/subagent-bridge.js`
  - Changed `DEFAULT_TIMEOUT_MS` from `15_000` to `null`.
  - Added `normalizeTimeoutMs()`.
  - Updated `evaluateLoopWithSubagent()` to skip timeout wrappers when the timeout is `null`.
  - Updated process execution to omit `execOptions.timeout` when unset.

- `index.ts`
  - Changed `DEFAULT_JUDGE_TIMEOUT_MS` from `15_000` to `null`.
  - Added an unconditional `console.info()` when the judge bridge activates.
  - The log format is:
    - `Ralph loop detector judge activated for <trigger>[ on <tool>]; evaluating now (timeout: unlimited).`

## Verification

I ran these successfully in the Ralph tree:

- `node --test test/*.test.js`
- `node --check index.ts`
- `node --check src/subagent-bridge.js`
- `node --check src/loop-detector.js`
- `node --check routing.js`

## Important Notes

- The user explicitly wants Ralph parity, including behavior and messages.
- The old tree was the one still producing the stale timeout and prompt text.
- If another agent works on this, it should start in `/home/matt/Sites/pi-extensions/pi-ralph-loop-detector` unless the user intentionally wants the newer tree only.
- The old tree still owns the Ralph-specific storage and recovery flow, including `.ralph` task/loop state.

## Likely Next Steps

1. Review the old Ralph tree for any remaining message mismatches with the original plugin.
2. Confirm whether the judge should emit more visible logs before/after dispatch.
3. Re-check `ralph_done` behavior for full parity with the old plugin.
4. If needed, add a small regression test around judge activation and timeout behavior.
