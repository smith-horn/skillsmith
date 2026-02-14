# Orchestration Patterns

Swarm topologies and coordination patterns for multi-agent workflows.

---

## Pattern 1: Hierarchical Coordination

**Best for**: Complex projects with clear delegation hierarchy

```javascript
// Initialize hierarchical swarm
mcp__claude-flow__swarm_init {
  topology: "hierarchical",
  maxAgents: 12
}

// Spawn coordinator
mcp__claude-flow__agent_spawn {
  type: "coordinator",
  capabilities: ["planning", "delegation", "monitoring"]
}

// Spawn specialized workers
mcp__claude-flow__agent_spawn { type: "architect" }
mcp__claude-flow__agent_spawn { type: "coder" }
mcp__claude-flow__agent_spawn { type: "tester" }
mcp__claude-flow__agent_spawn { type: "reviewer" }
```

**Use Cases**:
- Large enterprise projects
- Multi-team coordination
- Complex feature development

---

## Pattern 2: Mesh Coordination

**Best for**: Collaborative tasks requiring peer-to-peer communication

```javascript
mcp__claude-flow__swarm_init {
  topology: "mesh",
  strategy: "balanced",
  maxAgents: 6
}
```

**Use Cases**:
- Design reviews
- Brainstorming sessions
- Cross-functional collaboration

---

## Pattern 3: Sequential Pipeline

**Best for**: Ordered workflow execution (spec → design → code → test → review)

```javascript
mcp__claude-flow__workflow_create {
  name: "development-pipeline",
  steps: [
    { mode: "researcher", task: "gather requirements" },
    { mode: "architect", task: "design system" },
    { mode: "coder", task: "implement features" },
    { mode: "tdd", task: "create tests" },
    { mode: "reviewer", task: "review code" }
  ],
  triggers: ["on_step_complete"]
}
```

**Use Cases**:
- Waterfall-style projects
- Compliance-heavy workflows
- Audit trails required

---

## Pattern 4: Parallel Execution

**Best for**: Independent tasks that can run concurrently

```javascript
mcp__claude-flow__task_orchestrate {
  task: "build full-stack application",
  strategy: "parallel",
  dependencies: {
    backend: [],
    frontend: [],
    database: [],
    tests: ["backend", "frontend"]
  }
}
```

**Use Cases**:
- Microservices development
- Multi-component builds
- Independent feature development

---

## Pattern 5: Adaptive Strategy

**Best for**: Dynamic workloads with changing requirements

```javascript
mcp__claude-flow__swarm_init {
  topology: "hierarchical",
  strategy: "adaptive",  // Auto-adjusts based on workload
  maxAgents: 20
}
```

**Use Cases**:
- Agile sprints
- Evolving requirements
- Load-dependent scaling

---

## Topology Comparison

| Topology | Agents | Communication | Best For |
|----------|--------|---------------|----------|
| **Hierarchical** | 8-20 | Top-down | Enterprise projects |
| **Mesh** | 4-8 | Peer-to-peer | Collaboration |
| **Ring** | 3-6 | Sequential | Pipelines |
| **Star** | 3-8 | Hub-spoke | Centralized coordination |

---

## Memory Integration

**Always use Memory for cross-agent coordination**:

```javascript
// Store architectural decisions
mcp__claude-flow__memory_usage {
  action: "store",
  namespace: "architecture",
  key: "api-design-v1",
  value: JSON.stringify(apiDesign),
  ttl: 86400000  // 24 hours
}

// Retrieve in subsequent agents
mcp__claude-flow__memory_usage {
  action: "retrieve",
  namespace: "architecture",
  key: "api-design-v1"
}
```

---

## Parallel Operations Best Practice

**Batch all related operations in single message**:

```javascript
// ✅ CORRECT: All operations together
[Single Message]:
  mcp__claude-flow__agent_spawn { type: "researcher" }
  mcp__claude-flow__agent_spawn { type: "coder" }
  mcp__claude-flow__agent_spawn { type: "tester" }
  TodoWrite { todos: [8-10 todos] }

// ❌ WRONG: Multiple messages
Message 1: mcp__claude-flow__agent_spawn { type: "researcher" }
Message 2: mcp__claude-flow__agent_spawn { type: "coder" }
Message 3: TodoWrite { todos: [...] }
```

---

## Hook Integration

**Every SPARC mode should use hooks**:

```bash
# Before work
npx claude-flow@alpha hooks pre-task --description "implement auth"

# During work
npx claude-flow@alpha hooks post-edit --file "auth.js"

# After work
npx claude-flow@alpha hooks post-task --task-id "task-123"
```
