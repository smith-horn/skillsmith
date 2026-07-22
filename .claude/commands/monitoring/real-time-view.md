# real-time-view

Real-time view of swarm activity.

## v3 note

`monitoring` is not a top-level command in v3 (`npx -y ruflo@3.14.2 monitoring` errors immediately —
"Unknown command"). There is no `real-time-view` subcommand, `--filter`, `--highlight`, or `--tail`
flag. The closest live equivalent is continuous monitoring on swarm start — see
[swarm-monitor.md](./swarm-monitor.md) for the full point-in-time vs. continuous breakdown.

## Usage
```bash
npx -y ruflo@3.14.2 swarm start -o "<objective>" --monitor
```

## Examples
```bash
# Start a swarm with continuous monitoring on (default)
npx -y ruflo@3.14.2 swarm start -o "Build REST API" --monitor

# Point-in-time check instead
npx -y ruflo@3.14.2 swarm status
```
