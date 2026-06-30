# pi-transcript-review

Capture Pi conversation transcripts into a local SQLite event log so a model can review real runs from raw evidence and suggest improvements.

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
- `/transcript-review review [sessionId]`
- `/transcript-review review [sessionId] --slice full-session|front-of-session|around-compaction [--window N] [--page-chars N]`
- `/transcript-review analyze [sessionId]`
- `/transcript-review annotate <sessionId> <label> <body>`

## Tools

- `transcript_review_list_sessions`
- `transcript_review_get_session`
- `transcript_review_export_session`
- `transcript_review_annotate`
- `transcript_review_analyze`
- `transcript_review_review_session`
- `transcript_review_review_sessions`

## Notes

- Raw transcript data is stored immutably.
- Structured metadata is stored alongside the raw rows for filtering and analysis.
- The review workflow is read-only, targets one session at a time, prefers the current session when available, and otherwise uses the most recent completed session.
- Single-session review is paged one transcript item at a time with a character limit so the model can step through very large transcripts without loading everything at once.
- The paged review tool returns one item per page and carries `nextPage` cursors for continued inspection.
- The multi-session review tool returns evidence bundles, not extension-generated findings.
- The reviewer is expected to rank findings, cite transcript evidence, reject unsupported criticism, and give one concrete process change per finding.
- Named sessions override the recent-session default.
- The first version is local-first and workspace-scoped.
