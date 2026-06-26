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
- Pi imports your initial markdown into canonical structured plan state at `.ralph/<name>.plan.json`
- Pi renders `.ralph/<name>.md` as a generated snapshot for humans
- You let Pi know:
  1. What the task is and completion / tests to run
  2. How many items to process per iteration
  3. How often to commit
  4. (optionally) After how many items it should take a step back and self-reflect
- Pi runs `ralph_start`, beginning iteration 1.
  - It gets a prompt telling it to inspect and update task state via Ralph tools, then call `ralph_done` when it finishes that iteration
  - When the iteration is done, it calls `ralph_done`, resending the same prompt*
- Pi runs until either:
  - All tasks are done (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to clear the loop. Alternatively, just tell Pi to continue to keep going.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop |
| `/ralph resume [name]` | Resume a paused loop |
| `/ralph stop` | Pause current loop |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status` | Show all loops |
| `/ralph show-plan [loop]` | Show structured plan summary |
| `/ralph list-tasks [loop] [--status STATUS]` | Show structured tasks |
| `/ralph task <done\|block> <task-id> [loop]` | Quick task status update |
| `/ralph render-plan [loop]` | Regenerate markdown snapshot |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete a loop |
| `/ralph nuke [--yes]` | Delete all .ralph data |

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
and transcript intact, but Ralph trims the messages sent to the model so the next iteration starts at
the current Ralph prompt and task file instead of carrying the prior loop transcript.

CLI example:

```bash
/ralph start clean-slate --session-strategy newSession
```

Agent tool example:

```ts
ralph_start({
  name: "clean-slate",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  sessionStrategy: "newSession"
})
```

Options:

- `sessionStrategy`: `newSession` (default) or `followUp`
- `sessionStrategyFailure`: accepted for compatibility with existing state/config, but Ralph no longer calls Pi's command-only session replacement API.

`newSession` starts the next Ralph iteration in a fresh provider context seeded from the canonical structured plan state instead of carrying forward the prior loop transcript. Pi keeps the visible UI transcript intact rather than opening a separate session tab/file.

## Runtime Prompt Size

Ralph stores the full canonical plan, notes, verification, and reflection history in `.ralph/<name>.plan.json` and renders the full `.ralph/<name>.md` snapshot for humans. Iteration prompts use a minimal next-task runtime view instead of injecting the entire history every time.

The runtime view includes summary counts, a small goals list, one selected next task, and instructions for fetching more context only if that next task is ambiguous. Older history stays available through the compact `ralph_get_plan` summary, `ralph_list_tasks`, and the generated plan files, but it is omitted from the prompt to keep long-running loops within model context limits.

Each iteration prompt tells the agent to:

- Start from the single Next Task in the runtime view.
- Call compact `ralph_get_plan` or `ralph_list_tasks` only when that task lacks enough context.
- Mark active work with `ralph_update_task`, usually `in_progress` before work and `done` with evidence after verification.
- Use `blocked` plus a blocker note when work cannot continue.
- Treat `.ralph/<name>.md` as generated output and mutate canonical state only through Ralph tools.
- Call the real `ralph_done` tool when the iteration should advance.

## Agent Tool

The agent can self-start loops using `ralph_start`, then use plan tools such as `ralph_get_plan`, `ralph_list_tasks`, `ralph_update_task`, `ralph_add_task`, `ralph_add_note`, `ralph_record_reflection`, and `ralph_render_plan` to work without editing markdown directly:

```
ralph_start({
  name: "refactor-auth",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10,
  sessionStrategy: "newSession",
  sessionStrategyFailure: "followUp"
})
```

`taskContent` is still accepted for compatibility, but it is now imported once into structured plan state. After that, `.ralph/<name>.md` is generated output only.

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks.

## Changelog

See `CHANGELOG.md`.
