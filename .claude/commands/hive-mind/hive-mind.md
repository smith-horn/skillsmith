# hive-mind

Hive Mind collective intelligence system for advanced swarm coordination.

## Usage
```bash
npx -y ruflo@3.14.2 hive-mind <subcommand> [options]
```

## Subcommands
- `init` - Initialize hive mind system
- `spawn` - Spawn worker agents into the hive (use `--claude` to launch Claude Code)
- `status` - Show hive mind status
- `task` - Submit tasks to the hive
- `join` - Join an agent to the hive mind
- `leave` - Remove an agent from the hive mind
- `consensus` - Manage consensus proposals and voting
- `broadcast` - Broadcast a message to all workers in the hive
- `memory` - Access hive shared memory
- `optimize-memory` - Optimize hive memory and patterns
- `shutdown` - Shutdown the hive mind

`resume` and `stop` from earlier versions no longer exist in v3: `stop` was renamed `shutdown`; `resume` has no hive-scoped equivalent — the nearest is the top-level `session restore <id>`.

## Examples
```bash
# Initialize hive mind
npx -y ruflo@3.14.2 hive-mind init

# Spawn workers and launch Claude Code with an objective (no positional objective in v3)
npx -y ruflo@3.14.2 hive-mind spawn --claude -o "Build microservices"

# Check status
npx -y ruflo@3.14.2 hive-mind status
```
