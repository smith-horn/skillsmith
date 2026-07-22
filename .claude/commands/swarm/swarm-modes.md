# swarm-modes

Reference for v3 swarm/hive-mind topology and coordination modes.

`swarm swarm-modes` was never a valid command in any version — the old v2 "modes" concept doesn't exist as a subcommand in v3. What v3 actually has is a **topology** choice on `swarm init` / `hive-mind init`, plus a dedicated V3 coordination subcommand.

## Topologies

`swarm init` / `hive-mind init` accept (confirmed against the installed `ruflo@3.14.2` package source — the `TOPOLOGIES` array in `swarm.js`):

- `hierarchical` - Queen-led coordination with worker agents (default for `swarm init`)
- `mesh` - Fully connected peer-to-peer network
- `ring` - Circular communication pattern
- `star` - Central coordinator with spoke agents
- `hybrid` - Hierarchical mesh for maximum flexibility
- `hierarchical-mesh` - V3 15-agent queen + peer communication (default for `hive-mind init`; recommended)

## Usage
```bash
npx -y ruflo@3.14.2 swarm init --topology <topology>
npx -y ruflo@3.14.2 hive-mind init -t hierarchical-mesh
```

## V3 15-agent coordination

For the dedicated V3 hierarchical-mesh coordination mode:
```bash
npx -y ruflo@3.14.2 swarm coordinate --agents 15
```

## MCP

Topology tuning at runtime goes through `coordination_topology`, not a static swarm-modes-style list:

```javascript
mcp__ruflo__coordination_topology
```
