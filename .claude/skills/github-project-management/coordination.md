# Swarm Coordination

Multi-agent coordination for project management workflows.

---

## Swarm Initialization

### Project Management Swarm

```javascript
// Initialize comprehensive project swarm
mcp__claude-flow__swarm_init { topology: "hierarchical", maxAgents: 8 }

// Spawn specialized agents
mcp__claude-flow__agent_spawn { type: "coordinator", name: "Project Coordinator" }
mcp__claude-flow__agent_spawn { type: "analyst", name: "Requirements Analyst" }
mcp__claude-flow__agent_spawn { type: "architect", name: "Solution Architect" }
mcp__claude-flow__agent_spawn { type: "coder", name: "Developer 1" }
mcp__claude-flow__agent_spawn { type: "coder", name: "Developer 2" }
mcp__claude-flow__agent_spawn { type: "tester", name: "QA Engineer" }
mcp__claude-flow__agent_spawn { type: "reviewer", name: "Code Reviewer" }
mcp__claude-flow__agent_spawn { type: "writer", name: "Documentation Writer" }
```

### Topology Selection

| Topology | Use Case | Max Agents |
|----------|----------|------------|
| **Star** | Centralized coordination | 3-5 |
| **Mesh** | Collaborative work | 4-6 |
| **Hierarchical** | Large projects | 6-10 |
| **Ring** | Sequential workflows | 3-4 |

---

## Task Orchestration

### Coordinate Issue Resolution

```javascript
// Orchestrate issue workflow
mcp__claude-flow__task_orchestrate {
  task: "Resolve issue #123 with full review cycle",
  strategy: "sequential",
  steps: [
    { agent: "analyst", action: "analyze requirements" },
    { agent: "architect", action: "design solution" },
    { agent: "coder", action: "implement changes" },
    { agent: "tester", action: "write and run tests" },
    { agent: "reviewer", action: "review code" },
    { agent: "writer", action: "update documentation" }
  ]
}
```

### Parallel Execution

```javascript
// Execute independent tasks in parallel
mcp__claude-flow__task_orchestrate {
  task: "Sprint tasks batch execution",
  strategy: "parallel",
  tasks: [
    { issue: 123, agents: ["coder", "tester"] },
    { issue: 124, agents: ["coder", "tester"] },
    { issue: 125, agents: ["writer", "reviewer"] }
  ]
}
```

---

## Agent Coordination

### Shared Memory

```javascript
// Store shared context
mcp__claude-flow__memory_store {
  key: "project-context",
  value: {
    sprint: "Sprint 1 - Q1 2025",
    milestone: "v2.0 Release",
    team_capacity: 50,
    priorities: ["security", "performance"]
  }
}

// Retrieve in any agent
mcp__claude-flow__memory_retrieve { key: "project-context" }
```

### Agent Communication

```javascript
// Broadcast to all agents
mcp__claude-flow__hive-mind_broadcast {
  message: "Sprint goal updated: Focus on security features",
  priority: "high"
}

// Direct agent communication
mcp__claude-flow__agent_spawn {
  type: "coordinator",
  task: "Notify Developer 1 about blocking issue"
}
```

---

## Multi-Repository Coordination

### Cross-Repo Issue Sync

```bash
# Sync issues across repositories
npx ruv-swarm github multi-repo-sync \
  --repos "owner/repo1,owner/repo2,owner/repo3" \
  --label "cross-repo" \
  --sync-mode "bidirectional"
```

### Unified Project View

```bash
# Create unified view across repos
npx ruv-swarm github unified-project \
  --repos "owner/repo1,owner/repo2" \
  --project-id "$PROJECT_ID" \
  --include-prs
```

---

## Workflow Automation

### Issue Lifecycle Automation

```yaml
# .github/workflows/issue-swarm.yml
name: Issue Swarm Automation
on:
  issues:
    types: [opened, labeled]
  issue_comment:
    types: [created]

jobs:
  swarm-init:
    if: contains(github.event.issue.labels.*.name, 'swarm-ready')
    runs-on: ubuntu-latest
    steps:
      - name: Initialize Swarm
        run: |
          npx ruv-swarm github issue-to-swarm \
            ${{ github.event.issue.number }} \
            --auto-decompose \
            --assign-agents

  comment-handler:
    if: startsWith(github.event.comment.body, '/swarm')
    runs-on: ubuntu-latest
    steps:
      - name: Handle Command
        run: |
          npx ruv-swarm github handle-command \
            --issue ${{ github.event.issue.number }} \
            --command "${{ github.event.comment.body }}"
```

### PR Coordination

```yaml
# .github/workflows/pr-swarm.yml
name: PR Swarm Coordination
on:
  pull_request:
    types: [opened, ready_for_review]

jobs:
  coordinate-pr:
    runs-on: ubuntu-latest
    steps:
      - name: Spawn Review Agents
        run: |
          npx ruv-swarm github pr-agents \
            --pr ${{ github.event.pull_request.number }} \
            --agents "reviewer,tester,security"

      - name: Coordinate Review
        run: |
          npx ruv-swarm github pr-review-orchestrate \
            --pr ${{ github.event.pull_request.number }} \
            --strategy "parallel"
```

---

## Health Monitoring

### Swarm Health Check

```javascript
// Check swarm health
mcp__claude-flow__swarm_health {}

// Check specific agent
mcp__claude-flow__agent_health { agentId: "developer-1" }
```

### Performance Metrics

```bash
# Get coordination metrics
npx ruv-swarm github coordination-metrics \
  --period "7d" \
  --metrics "agent-efficiency,task-completion,bottlenecks"
```

---

## Error Handling

### Agent Recovery

```javascript
// Handle agent failure
mcp__claude-flow__agent_status { agentId: "developer-1" }

// Respawn if needed
mcp__claude-flow__agent_terminate { agentId: "developer-1", force: true }
mcp__claude-flow__agent_spawn { type: "coder", name: "Developer 1" }
```

### Task Retry

```bash
# Retry failed task
npx ruv-swarm github task-retry \
  --task-id "task-123" \
  --max-retries 3
```

---

## Cleanup

### Shutdown Swarm

```javascript
// Graceful shutdown
mcp__claude-flow__swarm_shutdown { graceful: true }

// Force shutdown
mcp__claude-flow__swarm_shutdown { graceful: false }
```

### Session Management

```javascript
// Save session state
mcp__claude-flow__session_save {
  name: "sprint-1-day-5",
  includeAgents: true,
  includeTasks: true,
  includeMemory: true
}

// Restore session
mcp__claude-flow__session_restore { name: "sprint-1-day-5" }
```
