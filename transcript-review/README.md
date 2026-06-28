# Conversation Transcript Review Proposal

Goal: store the full agent conversation stream in a queryable local database so a secondary agent can review real runs and suggest ecosystem changes that improve thinking time and accuracy.

## Why this matters

A transcript-only approach makes it hard to see patterns like:
- repeated file-reading before using structured tools
- slow recovery after compaction or session reload
- redundant tool calls
- prompt wording that causes loops or unnecessary work
- cases where the agent corrected itself versus needed manual intervention

## Recommended storage shape

Use an append-only event log in SQLite, not just a single blob of text.

Suggested tables:
- sessions: one row per loop/session/thread
- messages: every user/assistant/tool message with timestamps and role
- tool_calls: normalized tool invocation records and results
- lifecycle_events: compaction, reload, resume, reset, pause, complete
- annotations: human or agent labels for interesting turns
- metrics: latency, tool counts, retries, and outcome flags

## What to analyze later

A review agent should be able to answer questions like:
- Did the agent use Graphify before reading files?
- Did compaction cause context loss or a bad restart?
- Which prompt fragments correlate with looping or hesitation?
- Where does the model spend time without increasing accuracy?
- Which tool sequences produce the best outcomes?

## Practical guidance

- Keep raw messages immutable.
- Add structured metadata alongside the transcript.
- Record prompt/version IDs so changes can be correlated with behavior.
- Capture compaction boundaries and session resets explicitly.
- Prefer one database per workspace, with exports only if needed.

## Nice-to-have next step

Add a lightweight review workflow where another agent periodically scans completed sessions and outputs:
- recurring failure modes
- prompt changes worth trying
- tool-ordering changes worth trying
- state/migration improvements worth making
