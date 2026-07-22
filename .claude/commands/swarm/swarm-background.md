# swarm-background

Run swarm-related work detached from the current session.

`swarm swarm-background` was never a valid command in any version, and v3 has no `swarm background` subcommand either. Backgrounding is handled by three separate v3 command families — each confirmed live this session via `npx -y ruflo@3.14.2 <cmd> --help` — pick whichever fits the use case.

## `daemon` - background worker daemon

Manages the Node.js-based background worker daemon (auto-runs like a shell helper): start/stop/status/trigger enabled workers.
```bash
npx -y ruflo@3.14.2 daemon start
npx -y ruflo@3.14.2 daemon status
npx -y ruflo@3.14.2 daemon stop
```

## `process` - process management & monitoring

Broader background-process management, with its own `daemon`, `monitor`, `workers`, `signals`, and `logs` subcommands.
```bash
npx -y ruflo@3.14.2 process workers --action list
npx -y ruflo@3.14.2 process logs --follow
```

## `autopilot` - persistent swarm completion

Keeps agents working until all tasks are done — re-engages automatically instead of requiring a human to re-prompt. Closest match to "run this swarm in the background until it finishes."
```bash
npx -y ruflo@3.14.2 autopilot enable
npx -y ruflo@3.14.2 autopilot status
```

## Which one?

- Want the swarm to keep working unattended until its objective is complete → `autopilot`.
- Want a long-lived background worker process (not swarm-specific) → `daemon`.
- Want to inspect or manage whatever background processes are already running → `process`.
