# swarm-monitor

Real-time swarm monitoring.

## v3 note

`swarm monitor` does not exist in v3 — `npx -y ruflo@3.14.2 swarm monitor [options]` silently falls through to the `swarm` family help rather than erroring. There is no interval-poll equivalent: `--interval`, `--metrics`, and `--export` are all dead. Use one of the two v3 successors below instead. (This is the real monitoring doc — distinct from the auto-generated `commands/swarm/swarm-monitor.md` stub, which repoints here.)

## Point-in-time: `swarm status`

## Usage
```bash
npx -y ruflo@3.14.2 swarm status
```

Shows current swarm state as of the moment it's run — there is no watch/poll mode.

## Continuous: `swarm start --monitor`

`--monitor` defaults to `true` when starting a swarm — it is the closest v3 concept to the old standalone `swarm monitor`:

```bash
npx -y ruflo@3.14.2 swarm start -o "<objective>" --monitor
```

## MCP equivalents

Point-in-time or health-oriented monitoring is also available via MCP: `swarm_status`, `swarm_health`.

## Examples
```bash
# Point-in-time check
swarm status

# Start a swarm with monitoring on (default)
swarm start -o "Build REST API" --monitor
```
