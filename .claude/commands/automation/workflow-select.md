# workflow-select

Automatically select optimal workflow based on task type.

## v3 note

No `automation` family in v3 (`automation` errors, suggesting `autopilot`) — there is no `automation
workflow-select` command, `--constraints`, or `--preview` flag. The nearest live concept is
Q-Learning-based task-to-**agent** routing (verified via `route --help`), not workflow selection; a
real workflow **template** is still chosen explicitly via `workflow run -t <template>`.

## Usage
```bash
npx -y ruflo@3.14.2 route task "<task description>"
```

## Options
- `-a/--agent <type>` - Force a specific agent instead of Q-Learning selection
- `-q/--q-learning` - Use Q-Learning for agent selection (default: true)

## Examples
```bash
# Route a task to the optimal agent
npx -y ruflo@3.14.2 route task "Deploy to production"

# Force a specific agent instead of auto-routing
npx -y ruflo@3.14.2 route --agent coder "Database migration"

# Run a workflow template directly (explicit selection, no auto-select in v3)
npx -y ruflo@3.14.2 workflow run -t development --task "Database migration"
```
