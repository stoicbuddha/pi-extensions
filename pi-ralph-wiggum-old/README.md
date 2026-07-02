# Ralph Wiggum Extension

Long-running agent loops for iterative development. Best for long-running-tasks that are verifiable. Builds on Geoffrey Huntley's ralph-loop for Claude Code and adapts it for Pi.
This one is cool because:
- You can ask Pi and it will set up and run the loop all by itself in-session. If you prefer, it can also invoke another Pi via tmux
- You can have multiple parallel loops at once in the same repo (unlike OG ralph-wiggum)
- You can ask Pi to self-reflect at regular intervals so it doesn't mindlessly grind through wrong instructions (optional)

<img width="432" height="357" alt="Screenshot 2026-01-07 at 17 16 24" src="https://github.com/user-attachments/assets/68cdab11-76c6-4aed-9ea1-558cbb267ea6" />

**Note: This is a flat version without subagents, similar to the [Anthropic plugins implementation](https://github.com/anthropics/claude-code-plugins/tree/main/ralph-loop).**

## Installation

```bash
pi install npm:@tmustier/pi-ralph-wiggum
```

```bash
pi install git:github.com/tmustier/pi-extensions
```

Then filter to just this extension in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/tmustier/pi-extensions",
      "extensions": ["pi-ralph-wiggum/index.ts"],
      "skills": ["pi-ralph-wiggum/SKILL.md"]
    }
  ]
}
```

## Recommended usage: just ask Pi
You ask Pi to set up a ralph-wiggum loop.
- Pi creates the Ralph SQLite database automatically if it does not already exist
- Pi stores the loop state, tasks, notes, and reflections in that database
- You let Pi know:
  1. What the task is and completion / tests to run
  2. How many items to process per iteration
  3. How often to commit
  4. (optionally) After how many items it should take a step back and self-reflect
- The user starts the loop with `/ralph start`, beginning iteration 1.
  - It gets a prompt telling it to inspect and update task state via Ralph tools, then call `ralph_done` when it finishes that iteration
  - When the iteration is done, it calls `ralph_done`, resending the same prompt*
- Pi runs until either:
  - All tasks are done (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to clear the loop. Alternatively, just tell Pi to continue to keep going.

### State and migration

Ralph keeps loop state in SQLite and treats the database as the only canonical source of truth.

- The SQLite database and schema are created automatically on first use.
- Existing state is read from SQLite only.
- There are no extra generated files or sidecar files.
- Use the plan and task tools to inspect and update state.
- If a workspace-level `RALPH.md` exists, Ralph injects it into the loop prompt as extra top-of-mind guidance.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop, or resume it if that loop already exists |
| `/ralph resume [name]` | Resume a paused loop |
| `/ralph stop` | Pause current loop |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status` | Show all loops |
| `/ralph show-plan [loop]` | Show structured plan summary |
| `/ralph list-tasks [loop] [--status STATUS]` | Show structured tasks |
| `/ralph task <done\|block> <task-id> [loop]` | Quick task status update |
| `/ralph set-iteration <N> [loop]` | Set the current iteration value (0+) |
| `/ralph set-session-strategy <followUp\|newSession> [loop]` | Update the next-iteration session strategy |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete a loop |
| `/ralph nuke [--yes]` | Delete all Ralph database data |

### Options for start

| Option | Description |
|--------|-------------|
| `--max-iterations N` | Stop after N iterations (default 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint) |
| `--reflect-every N` | Reflect every N iterations |
| `--session-strategy MODE` | `newSession` (default) or `followUp` |
| `--session-strategy-failure MODE` | Accepted for compatibility; currently unused |

## Session Reset Options

Session reset is configured per loop, alongside the other Ralph iteration settings.

`newSession` provides a fresh provider context for each Ralph iteration. Pi keeps the visible session
and transcript intact, but Ralph seeds the next iteration from the current database state instead of
carrying the prior loop transcript.

CLI example:

```bash
/ralph start clean-slate --session-strategy newSession
```

Options:

- `sessionStrategy`: `newSession` (default) or `followUp`
- `sessionStrategyFailure`: accepted for compatibility with existing state/config, but Ralph no longer calls Pi's command-only session replacement API.

`newSession` starts the next Ralph iteration in a fresh provider context seeded from the canonical structured plan state instead of carrying forward the prior loop transcript. Pi keeps the visible UI transcript intact rather than opening a separate session tab/file.

## Runtime Prompt Size

Ralph stores the full canonical loop, plan, task, note, verification, reflection, and event history in SQLite. Iteration prompts use a minimal next-task runtime view instead of injecting the entire history every time.

The runtime view includes summary counts, a small goals list, one selected next task, and instructions for fetching more context only if that next task is ambiguous. Older history stays available through `ralph_get_plan`, `ralph_list_tasks`, and the structured database state, but it is omitted from the prompt to keep long-running loops within model context limits.

Each iteration prompt tells the agent to:

- Start from the single Next Task in the runtime view.
- Call compact `ralph_get_plan` or `ralph_list_tasks` only when that task lacks enough context.
- Mark active work with `ralph_update_task`, usually `in_progress` before work and `done` with evidence after verification.
- Use `blocked` plus a blocker note when work cannot continue.
- Treat the database as canonical and mutate state only through Ralph tools.
- Call the real `ralph_done` tool when the iteration should advance.

## Agent Tools

Agents cannot self-start Ralph loops anymore. Start or resume them with `/ralph start`, then the agent can use plan tools such as `ralph_get_plan`, `ralph_list_tasks`, `ralph_update_task`, `ralph_add_task`, `ralph_add_note`, and `ralph_record_reflection` to work without editing files directly.

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.

## Changelog

See `CHANGELOG.md`.
