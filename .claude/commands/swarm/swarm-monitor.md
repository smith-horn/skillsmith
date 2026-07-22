# swarm-monitor

Monitor an active swarm.

`swarm swarm-monitor` was never valid syntax in any version (doubled verb — this file was auto-generated filler), and v3 has no standalone `swarm monitor` subcommand either. Use one of:

## Usage
```bash
npx -y ruflo@3.14.2 swarm status
npx -y ruflo@3.14.2 swarm start -o "<objective>" --monitor
```

`--monitor` defaults to `true` on `swarm start`. MCP equivalents: `swarm_status`, `swarm_health`. For the full monitoring reference (including why the old `--interval`/`--metrics`/`--export` flags are gone), see `.claude/commands/monitoring/swarm-monitor.md` — a different file with the same base name.
