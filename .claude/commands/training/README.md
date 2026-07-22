# Neural Training Commands

Commands for the `neural` family in Ruflo (`train, status, patterns, predict, optimize, benchmark, list, export, import, router`). `training`/`train` are not CLI verbs in v3 — both error.

## Available Commands

- [neural-train](./neural-train.md) — train neural patterns via `neural train`
- [pattern-learn](./pattern-learn.md) — learn patterns via `neural patterns --action learn`
- [neural-patterns](./neural-patterns.md) — full `neural` training/status/patterns reference
- [specialization](./specialization.md) — agent specialization via `agent spawn` / `mcp__ruflo__agent_spawn`
- [model-update](./model-update.md) — no direct equivalent; pointer to the nearest re-training path (`neural train -m <id>`)
