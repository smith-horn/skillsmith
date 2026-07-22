# task-orchestrate

Orchestrate complex tasks across the swarm.

## v3 note

`task orchestrate` does not exist as a CLI subcommand in v3 (`task`'s real subcommands are `create,
list, status, cancel, assign, retry` — confirmed via `task --help`). There is no `--strategy` flag
on `task create`/`task assign` either. Two real successors, depending on what you need:

- **CLI, explicitly decomposed work**: `task create` (supports `-d/--description`, `-p/--priority`,
  `-a/--assign` for immediate agent assignment) followed by `task assign` for any task not assigned
  at creation time.
- **MCP, strategy-driven orchestration**: `mcp__ruflo__coordination_orchestrate` accepts a
  `strategy` param (e.g. `"parallel"`, `"adaptive"`) — use this when the old `--strategy` example
  is what you actually need.

## Usage
```bash
npx -y ruflo@3.14.2 task create -d "<task description>" [-p <priority>] [-a <agent-id>]
```

## Options
- `-t/--type <type>` - Task type
- `-d/--description <text>` - Task description
- `-p/--priority <level>` - Task priority [default: normal]
- `-a/--assign <agent-id(s)>` - Assign to agent(s) at creation time
- `--dependencies <ids>` - Comma-separated task IDs that must complete first
- `--timeout <seconds>` - Task timeout [default: 300]

## Examples
```bash
# Create a development task
npx -y ruflo@3.14.2 task create -d "Implement user authentication"

# High priority task
npx -y ruflo@3.14.2 task create -d "Fix production bug" -p critical

# Assign an existing task to a specific agent
npx -y ruflo@3.14.2 task assign task-123 -a coder-1
```

For strategy-driven orchestration (the old `--strategy parallel` use case):
```javascript
mcp__ruflo__coordination_orchestrate {
  task: "Refactor codebase",
  strategy: "parallel"
}
```
