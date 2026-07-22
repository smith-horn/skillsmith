# Parallel Task Execution

## Purpose
Execute independent subtasks in parallel for maximum efficiency.

## Coordination Strategy

### 1. Task Decomposition
```
Tool: mcp__ruflo__coordination_orchestrate
Parameters: {
  "task": "Build complete REST API with auth, CRUD operations, and tests",
  "strategy": "parallel",
  "maxAgents": 8
}
```

### 2. Parallel Workflows
The system automatically:
- Identifies independent components
- Assigns specialized agents
- Executes in parallel where possible
- Synchronizes at dependency points

### 3. Example Breakdown
For the REST API task:
- **Agent 1 (Architect)**: Design API structure
- **Agent 2-3 (Coders)**: Implement auth & CRUD in parallel
- **Agent 4 (Tester)**: Write tests as features complete
- **Agent 5 (Documenter)**: Update docs continuously

## CLI Usage
No `parallel` verb exists in v3. Use `swarm coordinate` (or start a swarm directly with an objective):
```bash
# Coordinate parallel execution across agents
npx -y ruflo@3.14.2 swarm coordinate --agents 8

# Or start a swarm with an objective directly
npx -y ruflo@3.14.2 swarm start -o "Build REST API" -s development
```

## Performance Gains
- 🚀 2.8-4.4x faster execution
- 💪 Optimal CPU utilization
- 🔄 Automatic load balancing
- 📈 Linear scalability with agents

## Monitoring
No interval-poll — `swarm_status` is point-in-time; call it repeatedly (or use CLI `swarm status`) to observe progress:
```
Tool: mcp__ruflo__swarm_status
Parameters: {"swarmId": "current"}
```

Watch real-time parallel execution progress!