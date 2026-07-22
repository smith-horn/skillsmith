# swarm-spawn

Add agents to an active swarm.

## v3 note

`swarm spawn` does not exist in v3 — `npx -y ruflo@3.14.2 swarm spawn [options]` silently falls through to the `swarm` family help rather than erroring (unknown ruflo subcommands exit 0). There are two v3 successors, depending on what you need.

## Primary: `agent_spawn` (MCP)

To add a single new agent by type, use the `agent_spawn` MCP tool. The required param is `agentType` (not `type`):

```javascript
mcp__ruflo__agent_spawn { agentType: "coder" }
```

## CLI approximation: `swarm scale`

`swarm scale` is the closest CLI equivalent, but it sets the swarm's **target agent count** — it is not an incremental "spawn N more" operation like the old `--count` implied. Do not treat it as 1:1.

## Usage
```bash
npx -y ruflo@3.14.2 swarm scale --agents <n> [--type <type>]
```

## Options
- `-a/--agents <n>` - Target number of agents (required; absolute total, not a delta)
- `-t/--type <type>` - Agent type to scale

`--capabilities` does not exist in v3 — there is no comma-separated capabilities flag on `swarm scale` or `agent_spawn`.

## Examples
```bash
# Scale the swarm to 3 coder agents (absolute target, not +3)
swarm scale --agents 3 --type coder
```

```javascript
// Spawn a single researcher agent via MCP
mcp__ruflo__agent_spawn { agentType: "researcher" }
```
