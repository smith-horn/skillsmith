# Automatic Topology Selection

## Purpose
Automatically select the optimal swarm topology based on task complexity analysis.

## How It Works

### 1. Task Analysis
The system analyzes your task description to determine:
- Complexity level (simple/medium/complex)
- Required agent types
- Estimated duration
- Resource requirements

### 2. Topology Selection
Based on analysis, it selects:
- **Star**: For simple, centralized tasks
- **Mesh**: For medium complexity with flexibility needs
- **Hierarchical**: For complex tasks requiring structure
- **Ring**: For sequential processing workflows

### 3. Example Usage

**Simple Task:**
```
Tool: mcp__ruflo__coordination_orchestrate
Parameters: {"task": "Fix typo in README.md"}
Result: Automatically uses star topology with single agent
```

**Complex Task:**
```
Tool: mcp__ruflo__coordination_orchestrate
Parameters: {"task": "Refactor authentication system with JWT, add tests, update documentation"}
Result: Automatically uses hierarchical topology with architect, coder, and tester agents
```

## Benefits
- 🎯 Optimal performance for each task type
- 🤖 Automatic agent assignment
- ⚡ Reduced setup time
- 📊 Better resource utilization

## Hook Configuration
`--optimize-topology` is dead in v3 (falls through silently — no error). The pre-task hook itself
no longer carries topology-selection logic; routing intent moves to `hooks route`:
```json
{
  "command": "npx -y ruflo@3.14.2 hooks pre-task -d \"<task>\" && npx -y ruflo@3.14.2 hooks route -t \"<task>\""
}
```

## Direct Optimization
```
Tool: mcp__ruflo__coordination_topology
Parameters: {"swarmId": "current"}
```

## CLI Usage
No `optimize` verb exists in v3. Topology is set at swarm creation and adjusted only via MCP at runtime:
```bash
# Set topology at swarm creation
npx -y ruflo@3.14.2 swarm init -t hierarchical --auto-scale
```
Runtime adjustment is MCP-only — see [Direct Optimization](#direct-optimization) above (`mcp__ruflo__coordination_topology`).