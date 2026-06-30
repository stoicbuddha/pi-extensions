# Pi Ralph Loop Detector

This package combines the loop-detector policy with Ralph-oriented recovery routing.

## What it does

- Detects suspicious repeated behavior from assistant messages, tool calls, and tool results
- Offloads loop judgment to an isolated Pi subprocess when available
- Routes recovery into a fresh session when `newSession` exists
- Falls back to the supported host follow-up path when `newSession` is unavailable
- Prefers the child-agent order `scout -> researcher -> reviewer`
- Exposes the legacy Ralph operator surface at `/ralph` plus `ralph_*` tools for listing loops, listing tasks, and updating plan state

## Usage

```js
import { LoopDetector } from "./src/index.js";
```

The package itself is loaded as a Pi extension. It keeps `detect_loop` as a compatibility tool, but the intended path is Ralph-centric recovery.

## Compatibility

The older `pi-loop-detector` and `pi-ralph-wiggum` packages stay in the monorepo, but this package is the merged entrypoint.
