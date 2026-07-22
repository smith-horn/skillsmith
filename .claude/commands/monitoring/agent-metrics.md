# agent-metrics

View agent performance metrics.

## Usage
```bash
npx -y ruflo@3.14.2 agent metrics [options]
```

## Options
- `-p/--period <time>` - Time period (1h/24h/7d/30d)

`--agent-id` does not exist in v3 — for a specific agent, use `agent status <id>` or `agent health <id>` instead. `--format` is a **global** CLI flag, not local to `agent metrics`. This is the CLI `agent metrics` command; there is no `mcp__ruflo__agent_metrics` MCP tool.

## Examples
```bash
# All agents metrics
agent metrics

# Specific agent
agent status agent-001

# Last hour
agent metrics --period 1h
```
