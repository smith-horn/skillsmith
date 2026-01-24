# Claude-Flow Integration

Swarm coordination patterns and batch operations for GitHub workflows.

---

## Initialize GitHub Swarm

```javascript
// Step 1: Initialize swarm coordination
mcp__claude-flow__swarm_init {
  topology: "hierarchical",
  maxAgents: 8
}

// Step 2: Spawn specialized agents
mcp__claude-flow__agent_spawn { type: "coordinator", name: "GitHub Coordinator" }
mcp__claude-flow__agent_spawn { type: "reviewer", name: "Code Reviewer" }
mcp__claude-flow__agent_spawn { type: "tester", name: "QA Agent" }
mcp__claude-flow__agent_spawn { type: "analyst", name: "Security Analyst" }

// Step 3: Orchestrate GitHub workflow
mcp__claude-flow__task_orchestrate {
  task: "Complete PR review and merge workflow",
  strategy: "parallel",
  priority: "high"
}
```

---

## GitHub Hooks Integration

### Pre-Task Setup

```bash
npx claude-flow@alpha hooks pre-task \
  --description "PR review workflow" \
  --context "pr-123"
```

### Progress Notification

```bash
npx claude-flow@alpha hooks notify \
  --message "Completed security scan" \
  --type "github-action"
```

### Post-Task Export

```bash
npx claude-flow@alpha hooks post-task \
  --task-id "pr-review-123" \
  --export-github-summary
```

---

## Batch Operations

### Concurrent GitHub CLI Commands

Execute multiple GitHub operations in a single message:

```javascript
[Concurrent Execution]:
  Bash("gh issue create --title 'Feature A' --body 'Description A' --label 'enhancement'")
  Bash("gh issue create --title 'Feature B' --body 'Description B' --label 'enhancement'")
  Bash("gh pr create --title 'PR 1' --head 'feature-a' --base 'main'")
  Bash("gh pr create --title 'PR 2' --head 'feature-b' --base 'main'")
  Bash("gh pr checks 123 --watch")
  TodoWrite { todos: [
    {content: "Review security scan results", status: "pending"},
    {content: "Merge approved PRs", status: "pending"},
    {content: "Update changelog", status: "pending"}
  ]}
```

---

## MCP Tool Reference

| Tool | Purpose |
|------|---------|
| `mcp__claude-flow__swarm_init` | Initialize swarm with topology |
| `mcp__claude-flow__agent_spawn` | Spawn specialist agents |
| `mcp__claude-flow__task_orchestrate` | Coordinate task execution |
| `mcp__claude-flow__memory_usage` | Shared memory operations |
| `mcp__claude-flow__swarm_destroy` | Cleanup swarm after completion |

---

## Agent Types for GitHub

| Agent | Role |
|-------|------|
| `coordinator` | Orchestrates GitHub workflows |
| `reviewer` | Code review and quality checks |
| `tester` | Test execution and validation |
| `analyst` | Security and performance analysis |

---

## Swarm Topologies

| Topology | Use Case |
|----------|----------|
| `hierarchical` | Complex multi-stage workflows |
| `mesh` | Peer-to-peer collaboration |
| `star` | Centralized coordination |

---

## Example: Full PR Workflow

```javascript
// Initialize hierarchical swarm for PR workflow
mcp__claude-flow__swarm_init {
  topology: "hierarchical",
  maxAgents: 4
}

// Spawn PR validation team
mcp__claude-flow__agent_spawn { type: "reviewer", name: "Code Reviewer" }
mcp__claude-flow__agent_spawn { type: "tester", name: "Test Runner" }
mcp__claude-flow__agent_spawn { type: "analyst", name: "Security Scanner" }

// Orchestrate validation
mcp__claude-flow__task_orchestrate {
  task: "Validate PR #123: Run tests, security scan, code review",
  strategy: "parallel"
}

// Store results in shared memory
mcp__claude-flow__memory_usage {
  action: "store",
  key: "pr-123-validation",
  value: JSON.stringify({
    tests: "passed",
    security: "no-issues",
    review: "approved"
  })
}
```
