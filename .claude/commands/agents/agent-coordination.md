# agent-coordination

Coordination patterns for multi-agent collaboration.

## Coordination Patterns

### Hierarchical
Queen-led with worker specialization
```bash
npx -y ruflo@3.14.2 swarm init --topology hierarchical
```

### Mesh
Peer-to-peer collaboration
```bash
npx -y ruflo@3.14.2 swarm init --topology mesh
```

### Adaptive
Dynamic topology based on workload — `adaptive` is not a documented `--topology` value in v3, so use
`--auto-scale` (default true) on a documented topology instead of an unverified `adaptive` value:
```bash
npx -y ruflo@3.14.2 swarm init --topology hierarchical --auto-scale
```

## Best Practices
- Use hierarchical for complex projects
- Use mesh for research tasks
- Use adaptive for unknown workloads
