# Optimization Commands

Commands for optimization operations in Ruflo. `optimization` is not a CLI family in v3 — these docs describe the surviving concepts (topology selection/tuning, parallel coordination) via their live v3 CLI/MCP equivalents (`swarm`, `performance`, and the `coordination_*` MCP tools). `parallel-execute` and `cache-manage` were removed: v3 has no batch-execute-from-file surface and no operation-cache surface.

## Available Commands

- [topology-optimize](./topology-optimize.md) — swarm topology tuning (MCP `coordination_topology`; no CLI equivalent — do not confuse with `performance optimize`)
- [auto-topology](./auto-topology.md) — automatic topology selection heuristics
- [parallel-execution](./parallel-execution.md) — parallel task coordination (`swarm coordinate`, MCP `coordination_orchestrate`)
