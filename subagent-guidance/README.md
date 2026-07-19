# subagent-guidance

Parent-only prompt injection for Pi subagent orchestration guidance.

This extension appends `~/.pi/agent/SUBAGENT_USE.md` to the system prompt for normal top-level Pi sessions, but skips `pi-subagents` child sessions. That lets you keep:

- shared problem-solving guidance in `AGENTS.md`
- parent-only orchestration guidance in `SUBAGENT_USE.md`

without leaking “how to use subagents” instructions into child agents.

## Install

```bash
pi install git:github.com/tmustier/pi-extensions
```

Or add just this extension:

```json
{
  "extensions": [
    "~/pi-extensions/subagent-guidance/index.ts"
  ]
}
```

## Usage

Create:

```text
~/.pi/agent/SUBAGENT_USE.md
```

Put parent-only guidance there, for example:

- when the main agent should delegate
- which subagents or chains to prefer
- examples of good and bad delegation
- how to brief workers and reviewers

Then reload Pi:

```text
/reload
```

## Behavior

- Injects guidance in `before_agent_start`
- Skips injection when `PI_SUBAGENT_CHILD=1`
- Does nothing if `~/.pi/agent/SUBAGENT_USE.md` does not exist or is empty
