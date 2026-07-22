# route task (formerly "auto agent")

Automatically route a task to the optimal agent using Q-Learning. There is no `auto agent` family in v3 — the closest live surface is `route`, backed by `swarm coordinate` / `autopilot` for full multi-agent orchestration.

## Usage

```bash
npx -y ruflo@3.14.2 route task "<task description>" [options]
```

## Options

- `-a, --agent <type>` - Force a specific agent (bypasses Q-Learning)
- `-q, --q-learning` - Use Q-Learning for agent selection (default: true)
- `-e, --explore` - Enable exploration (random selection chance) (default: true)
- `-j, --json` - Output in JSON format (default: false)

## Examples

### Basic routing

```bash
npx -y ruflo@3.14.2 route task "Build a REST API with authentication"
```

### Force a specific agent

```bash
route task "Debug performance issue" --agent reviewer
```

### List available agent types for routing

```bash
route list-agents
```

### Disable exploration (always take the learned best route)

```bash
route task "Fix bug in login" --explore false
```

## How It Works

1. **Task Analysis**

   - Parses the task description
   - Looks up learned Q-values for similar past tasks
   - Falls back to exploration when confidence is low

2. **Agent Selection**

   - Q-Learning picks the agent type with the best learned outcome for the task, unless `--agent` forces a specific one
   - `route feedback` records the outcome so future routing improves

3. **Full Orchestration**

   `route task` only routes — it does not spawn or coordinate a swarm by itself. For multi-agent orchestration, hand off to:

   ```bash
   swarm coordinate --agents 15   # V3 15-agent hierarchical mesh coordination
   autopilot enable                # keep agents working until all tasks are done
   autopilot status
   ```

## Agent Types Selected

- **Architect**: System design, architecture decisions
- **Coder**: Implementation, code generation
- **Tester**: Test creation, quality assurance
- **Analyst**: Performance, optimization
- **Researcher**: Documentation, best practices
- **Coordinator**: Task management, progress tracking

## Selecting Between Routing Modes

### Q-Learning (default)

- Learns from `route feedback` over time
- Best when there's routing history to draw on

### Forced agent (`--agent <type>`)

- Bypasses Q-Learning entirely
- Best when you already know which agent type the task needs

### Exploration (`--explore`)

- Occasionally tries a non-optimal agent to keep learning
- Disable (`--explore false`) once routing quality is trusted for a task class

## Integration with Claude Code

```javascript
// In Claude Code, pick an agent type then spawn it explicitly
mcp__ruflo__guidance_recommend({
  task: "Build authentication system"
})

mcp__ruflo__agent_spawn({
  agentType: "coder",
  name: "Auth Builder"
})
```

## See Also

- `agent spawn` - Manual agent creation
- `swarm init` / `swarm coordinate` - Initialize and run swarm coordination
- `smart-spawn` - `hooks route` / `hooks build-agents` based agent spawning
- `autopilot` - Persistent multi-task completion
