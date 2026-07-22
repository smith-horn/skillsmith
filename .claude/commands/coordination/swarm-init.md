# swarm init

Initialize a Ruflo swarm with specified topology and configuration.

## Usage

```bash
npx -y ruflo@3.14.2 swarm init [options]
```

## Options

- `--topology, -t <type>` - Swarm topology: mesh, hierarchical, ring, star (default: hierarchical)
- `--max-agents, -m <number>` - Maximum number of agents (default: 15)
- `--strategy, -s <type>` - Coordination strategy: `specialized`, `balanced`, `adaptive`, `research`,
  `development` (default), `testing`, `optimization`, `maintenance`, `analysis` — confirmed values
  only; see [swarm-strategies.md](../swarm/swarm-strategies.md) for the full verified list
- `--auto-scale` - Enable automatic scaling (default: true)
- `--v3-mode` - Enable V3 15-agent hierarchical mesh mode (default: false)

No `--auto-spawn`, `--memory`, or `--github` flag exists on `swarm init` in v3.

## Examples

### Basic initialization

```bash
npx -y ruflo@3.14.2 swarm init
```

### Mesh topology for research

```bash
npx -y ruflo@3.14.2 swarm init --topology mesh --max-agents 5 --strategy balanced
```

### Hierarchical for development

```bash
npx -y ruflo@3.14.2 swarm init --topology hierarchical --max-agents 10 --strategy development --auto-scale
```

### Star topology

```bash
npx -y ruflo@3.14.2 swarm init --topology star
```

GitHub integration and cross-session memory persistence are not `swarm init` flags in v3 — they're
handled separately via the `github_*` MCP tools and the `memory` family respectively.

## Topologies

### Mesh

- All agents connect to all others
- Best for: Research, exploration, brainstorming
- Communication: High overhead, maximum information sharing

### Hierarchical

- Tree structure with clear command chain
- Best for: Development, structured tasks, large projects
- Communication: Efficient, clear responsibilities

### Ring

- Agents connect in a circle
- Best for: Pipeline processing, sequential workflows
- Communication: Low overhead, ordered processing

### Star

- Central coordinator with satellite agents
- Best for: Simple tasks, centralized control
- Communication: Minimal overhead, clear coordination

## Integration with Claude Code

Once initialized, use MCP tools in Claude Code:

```javascript
mcp__ruflo__swarm_init { topology: "hierarchical", maxAgents: 8 }
```

## See Also

- `agent spawn` - Create swarm agents
- `task create` / `task assign` (or MCP `coordination_orchestrate`) - Coordinate task execution
- `swarm status` - Check swarm state
- `swarm monitor` - Real-time monitoring
