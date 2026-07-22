# smart-spawn (formerly `automation smart-spawn`)

There is no `automation` verb and no `smart-spawn` subcommand in v3 — no single command replicates "analyze workload, then auto-spawn agents." The closest live building blocks are `hooks route` (route a task to the agent learned patterns favor) and `hooks build-agents` (generate agent configs from pretrain data), combined with an explicit `agent spawn`.

## Usage
```bash
npx -y ruflo@3.14.2 hooks route [options]
npx -y ruflo@3.14.2 hooks build-agents [options]
```

## Options

### `hooks route`
- `-t, --task <description>` - Task description (required)
- `-c, --context <text>` - Additional context
- `-K, --top-k <n>` - Number of top agent suggestions (default: 3)

### `hooks build-agents`
- `-o, --output <dir>` - Output directory for agent configs (default: `./agents`)
- `-f, --focus <area>` - Focus area: `v3-implementation`, `security`, `performance`, `all` (default: `all`)
- `--config-format <fmt>` - Config format: `yaml`, `json` (default: `yaml`)

## Examples
```bash
# Route a task to the agent the learned patterns favor
hooks route -t "Refactor the auth module" -K 5

# Generate agent configs focused on performance work
hooks build-agents --focus performance -o ./config/agents

# Spawn the agent hooks route recommended
agent spawn -t coder
```

There is no workload-analysis auto-spawn command, no `--analyze` flag, no `--threshold`, and no `--topology` flag on either of these — topology is set via `swarm init`.
