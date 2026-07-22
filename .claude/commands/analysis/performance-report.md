# performance-report

Generate comprehensive performance reports for swarm operations. There is no `analysis` verb and no `performance report` subcommand in v3 — the CLI surface is `performance metrics`; the MCP surface is `mcp__ruflo__performance_report`.

## Usage
```bash
npx -y ruflo@3.14.2 performance metrics [options]
```

## Options
- `-t, --timeframe <range>` - Timeframe: `1h`, `24h`, `7d`, `30d` (default: `24h`)
- `-f, --format <type>` - Output format: `text`, `json`, `prometheus` (default: `text`)
- `-c, --component <name>` - Component to filter

There is no `--include-metrics` or `--compare <id>` flag, and `--format` does not accept `html` or `markdown` — only `text`, `json`, `prometheus`.

## Examples
```bash
# Last 7 days
npx -y ruflo@3.14.2 performance metrics -t 7d

# Export as Prometheus format
performance metrics -f prometheus

# Filter to one component, JSON output
performance metrics -c coordinator -f json
```

## MCP form

```javascript
mcp__ruflo__performance_report({
  components: ["coordinator"],
  format: "summary",   // "json" | "summary" | "detailed" — no "html"
  timeRange: "24h"
})
```
