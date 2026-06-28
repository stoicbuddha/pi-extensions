# pi-transcript-review

Capture Pi conversation transcripts into a local SQLite event log so a secondary agent can review real runs and suggest improvements.

## What it stores

- sessions
- messages
- tool calls and tool results
- lifecycle events such as compaction and shutdown
- annotations
- lightweight metrics

The database lives in `.pi-transcript-review/transcript-review.sqlite` in the current workspace.

## Commands

- `/transcript-review status`
- `/transcript-review list [limit]`
- `/transcript-review show [sessionId]`
- `/transcript-review export [sessionId]`
- `/transcript-review analyze [sessionId]`
- `/transcript-review annotate <sessionId> <label> <body>`

## Tools

- `transcript_review_list_sessions`
- `transcript_review_get_session`
- `transcript_review_export_session`
- `transcript_review_annotate`
- `transcript_review_analyze`

## Notes

- Raw transcript data is stored immutably.
- Structured metadata is stored alongside the raw rows for filtering and analysis.
- The first version is local-first and workspace-scoped.
