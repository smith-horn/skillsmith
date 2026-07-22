# hive-mind-metrics

Command documentation for hive-mind-metrics in category hive-mind. There is no standalone `hive-mind metrics` subcommand in v3 — use `hive-mind status --detailed`, or the broader `performance metrics` command for cross-component metrics. `-d/--detailed` confirmed live against `npx -y ruflo@3.14.2 hive-mind status --help` (SMI-5777 code-review follow-up; the plan itself only had bare `hive-mind status` live-verified at write time).

Usage:
```bash
npx -y ruflo@3.14.2 hive-mind status --detailed
npx -y ruflo@3.14.2 performance metrics
```

MCP equivalents: `mcp__ruflo__hive-mind_status`, `mcp__ruflo__performance_metrics`.
