# hooks pre-task

Execute pre-task preparations and context loading.

## Usage

```bash
npx -y ruflo@3.14.2 hooks pre-task [options]
```

## Options

- `--task-id, -i <id>` - Task identifier (auto-generated if omitted)
- `--description, -d <text>` - Task description for context (required)
- `--auto-spawn, -a` - Automatically spawn required agents (default: false)

## Examples

### Basic pre-task hook

```bash
hooks pre-task --description "Implement user authentication"
```

### Cross-session restore

```bash
hooks pre-task -d "Continue API development"
```

Cross-session memory restore is a separate step in v3: `hooks session-restore`.

### No auto-spawn (default behavior)

```bash
hooks pre-task -d "Debug issue #123"
```

Auto-spawn is off by default in v3; pass `--auto-spawn` to opt in.

### Task description only

```bash
hooks pre-task -d "Refactor codebase"
```

Topology and complexity routing moved to `hooks route -t "<task>"` and `hooks model-route`.

## Features

### Auto Agent Assignment

- Analyzes task requirements
- Determines needed agent types
- Spawns agents automatically
- Configures agent parameters

### Memory Loading

- Retrieves relevant past decisions
- Loads previous task contexts
- Restores agent configurations
- Maintains continuity

### Topology Optimization

- Analyzes task structure
- Selects best swarm topology
- Configures communication patterns
- Optimizes for performance

### Complexity Estimation

- Evaluates task difficulty
- Estimates time requirements
- Suggests agent count
- Identifies dependencies

## Integration

This hook is automatically called by Claude Code when:

- Starting a new task
- Resuming work after a break
- Switching between projects
- Beginning complex operations

Manual usage in agents:

```bash
# In agent coordination
hooks pre-task --description "Your task here"
```

## Output

Returns JSON with:

```json
{
  "continue": true,
  "topology": "hierarchical",
  "agentsSpawned": 5,
  "complexity": "medium",
  "estimatedMinutes": 30,
  "memoryLoaded": true
}
```

## See Also

- `hooks post-task` - Post-task cleanup
- `agent spawn` - Manual agent creation
- `memory usage` - Memory management
- `swarm init` - Swarm initialization
