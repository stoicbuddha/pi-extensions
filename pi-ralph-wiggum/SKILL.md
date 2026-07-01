---
name: pi-ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum - Long-Running Development Loops

The user starts a loop with `/ralph start <name|path> [options]`.
If `/ralph start` is called for an existing loop name, Ralph treats it as `/ralph resume`.

## Loop Behavior

1. `/ralph start` stores the initial task content in the Ralph SQLite database.
2. Use Ralph plan tools to inspect and update tasks, notes, evidence, and reflections.
3. Call `ralph_done` to proceed to the next iteration.
4. Output `<promise>COMPLETE</promise>` when finished.
5. Stop when complete or when max iterations is reached (default 50).

## State Storage

- The SQLite database and schema are created automatically the first time Ralph is used in a workspace.
- The database is the only canonical source of truth.
- Use the plan and task tools to inspect or update state.
- A workspace-level `RALPH.md` is optional and is injected into the Ralph prompt as additional guidance.

## Plan Tools

- `ralph_get_plan` - Return a compact authoritative plan summary.
- `ralph_list_tasks` - Return ordered tasks and statuses for quick inspection.
- `ralph_update_task` - Safely update task status, details, notes, evidence, or order.
- `ralph_add_task` - Add newly discovered work items.
- `ralph_add_note` - Append loop-level progress or blocker notes.
- `ralph_record_reflection` - Persist reflection checkpoints in canonical state.

## User Commands

- `/ralph start <name|path>` - Start a new loop, or resume it if that loop already exists.
- `/ralph resume [name]` - Resume loop.
- `/ralph stop` - Pause loop (when agent idle).
- `/ralph-stop` - Stop active loop (idle only).
- `/ralph status` - Show loops.
- `/ralph show-plan [loop]` - Show a structured plan summary.
- `/ralph list-tasks [loop] [--status STATUS]` - Show structured tasks.
- `/ralph task <done|block> <task-id> [loop]` - Quick task update.
- `/ralph set-iteration <N> [loop]` - Set the current iteration value (0+).
- `/ralph set-session-strategy <followUp|newSession> [loop]` - Update the next-iteration session strategy.
- `/ralph list --archived` - Show archived loops.
- `/ralph archive <name>` - Move loop to archive.
- `/ralph clean [--all]` - Clean completed loops.
- `/ralph cancel <name>` - Delete loop.
- `/ralph nuke [--yes]` - Delete all Ralph database data.

Press ESC to interrupt streaming, send a normal message to resume, and run `/ralph-stop` when idle to end the loop.

## Best Practices

1. Start with a clear checklist in `taskContent`; Ralph will import it into structured tasks.
2. Use Ralph plan tools instead of direct file edits.
3. Capture verification evidence as task evidence or loop notes.
4. Reflect when stuck to reassess approach.
5. Output the completion marker only when truly done.
