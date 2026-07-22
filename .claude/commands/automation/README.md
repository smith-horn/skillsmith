# Automation Commands

`automation` is not a v3 CLI verb — running it errors out. These docs describe automation-shaped workflows built from real v3 surfaces: task routing (`route`), the self-learning hooks system (`hooks route`, `hooks build-agents`), persistent multi-agent completion (`autopilot`), and discrete memory tools (`memory_retrieve`/`memory_list`/`memory_delete`/`memory_store` etc., not an `action`-dispatched `memory_usage`).

## Available Commands

- [auto-agent](./auto-agent.md) — task-to-agent routing via `route task`
- [smart-agents](./smart-agents.md)
- [smart-spawn](./smart-spawn.md) — agent selection via `hooks route` / `hooks build-agents`
- [session-memory](./session-memory.md)
- [self-healing](./self-healing.md)
- [workflow-select](./workflow-select.md)
