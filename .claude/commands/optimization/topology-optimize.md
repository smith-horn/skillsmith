# topology-optimize

Optimize swarm topology for the current workload.

## Live v3 Ground Truth

There is no CLI `topology-optimize` command — `optimization` is not a CLI family in v3 at all. Topology is:

- **Set at swarm creation**: `swarm init -t <topology> --auto-scale`
- **Adjusted at runtime**: MCP tool `mcp__ruflo__coordination_topology` (no CLI wrapper exists)

**Trap**: CLI `performance optimize --target <metric> [--apply]` shares the `--target`/`--apply` flag shape with this file's old syntax, but it optimizes memory/cpu/latency — **not swarm topology**. Do not substitute one for the other; they are different target spaces.

## MCP Usage

```
Tool: mcp__ruflo__coordination_topology
Parameters: {"swarmId": "current"}
```

## Setting Topology at Init

```bash
# Choose the topology when the swarm is created
npx -y ruflo@3.14.2 swarm init -t hierarchical --auto-scale
```

## Related

- [auto-topology](./auto-topology.md) — automatic topology selection heuristics
