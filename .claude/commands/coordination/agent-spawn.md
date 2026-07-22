# agent-spawn

Spawn a new agent in the current swarm.

## Usage
```bash
npx -y ruflo@3.14.2 agent spawn [options]
```

## Options
- `-t/--type <type>` - Agent type (coder, researcher, analyst, tester, coordinator)
- `-n/--name <name>` - Custom agent name
- `-p/--provider <provider>` - Model provider
- `-m/--model <model>` - Specific model to use
- `--task <description>` - Task for the agent to perform
- `--timeout <ms>` - Spawn timeout
- `--auto-tools` - Automatically enable tools

`--skills` does not exist in v3 — there is no comma-separated skills flag on `agent spawn`.

## Examples
```bash
# Spawn coder agent
agent spawn --type coder

# With custom name
agent spawn --type researcher --name "API Expert"

# With a task description
agent spawn --type coder --task "Implement OAuth flow"
```
