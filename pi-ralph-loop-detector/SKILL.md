---
name: pi-ralph-loop-detector
description: Detect Ralph loop behavior, route recovery into fresh sessions when available, and preserve the detector as a compatibility tool.
---

# Pi Ralph Loop Detector

Use this extension when Ralph needs loop-aware recovery with a fixed child-agent preference order.

## Behavior

- detect repeated tool misuse, intent mismatch, repeated failures, and self-correction loops
- judge suspicious behavior in an isolated subprocess when possible
- route recovery into `newSession` first
- fall back to the host's supported follow-up path when `newSession` is unavailable
- prefer `scout`, then `researcher`, then `reviewer`

## Compatibility

- keep `detect_loop` available for inspection and legacy automation
- keep the older packages around, but treat this package as the merged Ralph-focused entrypoint
