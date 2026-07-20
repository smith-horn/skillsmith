# swarm

Main swarm orchestration command for Ruflo.

## Usage
```bash
npx ruflo swarm start -o <objective> [options]
```

## Options
- `-s, --strategy <type>` - Execution strategy
- `-p, --parallel` - Enable parallel execution (default: true)
- `--monitor` - Enable real-time monitoring (default: true)

`--mode`, `--max-agents`, `--config`, and `--claude` (v2-only flags) have no v3 equivalent and are not available.

## Examples
```bash
# Basic swarm
npx ruflo swarm start -o "Build REST API"

# With strategy
npx ruflo swarm start -o "Research AI patterns" -s research
```
