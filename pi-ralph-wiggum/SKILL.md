---
name: pi-ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum - Long-Running Development Loops

Use the `ralph_start` tool to begin a loop:

```
ralph_start({
  name: "loop-name",
  taskContent: "# Task\n\n## Goals\n- Goal 1\n\n## Checklist\n- [ ] Item 1\n- [ ] Item 2",
  maxIterations: 50,        // Default: 50
  itemsPerIteration: 3,     // Optional: suggest N items per turn
  reflectEvery: 10          // Optional: reflect every N iterations
})
```

## Loop Behavior

1. `ralph_start` imports the markdown task into canonical structured plan state in `.ralph/ralph.sqlite`.
2. Ralph renders `.ralph/<name>.md` as a generated snapshot for humans.
3. Use Ralph plan tools to inspect and update tasks, notes, evidence, and reflections.
4. Do not edit the generated markdown snapshot directly.
5. Call `ralph_done` to proceed to the next iteration.
6. Output `<promise>COMPLETE</promise>` when finished.
7. Stop when complete or when max iterations is reached (default 50).

## State Storage

- The SQLite database and schema are created automatically the first time Ralph is used in a workspace.
- Existing `.ralph/<name>.state.json` and `.ralph/<name>.plan.json` files are imported automatically on first access.
- If both SQLite and legacy files exist, SQLite is treated as canonical.
- Use `ralph_render_plan` if you need to regenerate the human-readable snapshot from the database state.

## Plan Tools

- `ralph_get_plan` - Return a compact authoritative plan summary.
- `ralph_list_tasks` - Return ordered tasks and statuses for quick inspection.
- `ralph_update_task` - Safely update task status, details, notes, evidence, or order.
- `ralph_add_task` - Add newly discovered work items.
- `ralph_add_note` - Append loop-level progress or blocker notes.
- `ralph_record_reflection` - Persist reflection checkpoints in canonical state.
- `ralph_render_plan` - Regenerate the markdown snapshot from JSON state.

## User Commands

- `/ralph start <name|path>` - Start a new loop.
- `/ralph resume [name]` - Resume loop.
- `/ralph stop` - Pause loop (when agent idle).
- `/ralph-stop` - Stop active loop (idle only).
- `/ralph status` - Show loops.
- `/ralph show-plan [loop]` - Show a structured plan summary.
- `/ralph list-tasks [loop] [--status STATUS]` - Show structured tasks.
- `/ralph task <done|block> <task-id> [loop]` - Quick task update.
- `/ralph render-plan [loop]` - Regenerate the markdown snapshot.
- `/ralph list --archived` - Show archived loops.
- `/ralph archive <name>` - Move loop to archive.
- `/ralph clean [--all]` - Clean completed loops.
- `/ralph cancel <name>` - Delete loop.
- `/ralph nuke [--yes]` - Delete all .ralph data.

Press ESC to interrupt streaming, send a normal message to resume, and run `/ralph-stop` when idle to end the loop.

## Rendered Snapshot Format

```markdown
# Task Title

Brief description.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2
- [x] Completed item

## Verification
- Evidence, commands run, or file paths

## Notes
(Update with progress, decisions, blockers)
```

The snapshot is informational. Canonical state lives in `.ralph/ralph.sqlite`.

## Best Practices

1. Start with a clear checklist in `taskContent`; Ralph will import it into structured tasks.
2. Use Ralph plan tools instead of direct file edits.
3. Capture verification evidence as task evidence or loop notes.
4. Reflect when stuck to reassess approach.
5. Output the completion marker only when truly done.
