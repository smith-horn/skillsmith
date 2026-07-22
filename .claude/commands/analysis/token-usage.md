# token-usage

Analyze token usage patterns and optimize for efficiency. There is no `analysis` verb and no `token-usage` command in v3 — token savings come from `hooks token-optimize`, and per-model routing stats come from `hooks model-stats`.

## Usage
```bash
npx -y ruflo@3.14.2 hooks token-optimize [options]
npx -y ruflo@3.14.2 hooks model-stats [options]
```

## Options

### `hooks token-optimize`
- `-q, --query <text>` - Query for compact context retrieval
- `-A, --agents <n>` - Agent count for optimal config (default: `6`)
- `-r, --report` - Generate optimization report
- `-s, --stats` - Show token savings statistics

### `hooks model-stats`
- `-d, --detailed` - Show detailed breakdown

There is no `--period`, `--by-agent`, or `--export` flag on either command.

## Examples
```bash
# Token savings stats
npx -y ruflo@3.14.2 hooks token-optimize --stats

# Optimal config + report for 8 agents
hooks token-optimize -A 8 --report

# Per-model routing breakdown
hooks model-stats --detailed
```
