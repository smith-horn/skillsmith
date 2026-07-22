# swarm-init

Initialize a new swarm with specified topology.

## Usage
```bash
npx -y ruflo@3.14.2 swarm init [options]
```

## Options
- `--topology <type>` - Swarm topology (mesh, hierarchical, ring, star)
- `--max-agents <n>` - Maximum agents
- `--strategy <type>` - Distribution strategy

## Examples
```bash
npx -y ruflo@3.14.2 swarm init --topology mesh
npx -y ruflo@3.14.2 swarm init --topology hierarchical --max-agents 8
```
