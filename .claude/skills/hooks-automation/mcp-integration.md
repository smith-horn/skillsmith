# MCP Integration

Hooks that coordinate with MCP swarm tools and memory coordination protocols.

---

## MCP Integration Hooks

### mcp-initialized

Persist swarm configuration.

```bash
npx claude-flow hook mcp-initialized --swarm-id <id>

Features:
- Save swarm topology and configuration
- Store agent roster in memory
- Initialize coordination namespace
```

### agent-spawned

Update agent roster and memory.

```bash
npx claude-flow hook agent-spawned --agent-id <id> --type <type>

Features:
- Register agent in coordination memory
- Update agent roster
- Initialize agent-specific memory namespace
```

### task-orchestrated

Monitor task progress.

```bash
npx claude-flow hook task-orchestrated --task-id <id>

Features:
- Track task progress through memory
- Monitor agent assignments
- Update coordination state
```

### neural-trained

Save pattern improvements.

```bash
npx claude-flow hook neural-trained --pattern <name>

Features:
- Export trained neural patterns
- Update coordination models
- Share learning across agents
```

---

## Memory Coordination Hooks

### memory-write

Triggered when agents write to coordination memory.

```bash
Features:
- Validate memory key format
- Update cross-agent indexes
- Trigger dependent hooks
- Notify subscribed agents
```

### memory-read

Triggered when agents read from coordination memory.

```bash
Features:
- Log access patterns
- Update popularity metrics
- Preload related data
- Track usage statistics
```

### memory-sync

Synchronize memory across swarm agents.

```bash
npx claude-flow hook memory-sync --namespace <ns>

Features:
- Sync memory state across agents
- Resolve conflicts
- Propagate updates
- Maintain consistency
```

---

## Three-Phase Memory Protocol

All hooks follow a standardized memory coordination pattern.

### Phase 1: STATUS

Hook starts.

```javascript
mcp__claude-flow__memory_usage {
  action: "store",
  key: "swarm/hooks/pre-edit/status",
  namespace: "coordination",
  value: JSON.stringify({
    status: "running",
    hook: "pre-edit",
    file: "src/auth.js",
    timestamp: Date.now()
  })
}
```

### Phase 2: PROGRESS

Hook processes.

```javascript
mcp__claude-flow__memory_usage {
  action: "store",
  key: "swarm/hooks/pre-edit/progress",
  namespace: "coordination",
  value: JSON.stringify({
    progress: 50,
    action: "validating syntax",
    file: "src/auth.js"
  })
}
```

### Phase 3: COMPLETE

Hook finishes.

```javascript
mcp__claude-flow__memory_usage {
  action: "store",
  key: "swarm/hooks/pre-edit/complete",
  namespace: "coordination",
  value: JSON.stringify({
    status: "complete",
    result: "success",
    agent_assigned: "backend-dev",
    syntax_valid: true,
    backup_created: true
  })
}
```

---

## Hook Response Format

### Continue Response

```json
{
  "continue": true,
  "reason": "All validations passed",
  "metadata": {
    "agent_assigned": "backend-dev",
    "syntax_valid": true,
    "file": "src/auth.js"
  }
}
```

### Block Response

```json
{
  "continue": false,
  "reason": "Protected file - manual review required",
  "metadata": {
    "file": ".env.production",
    "protection_level": "high",
    "requires": "manual_approval"
  }
}
```

### Warning Response

```json
{
  "continue": true,
  "reason": "Syntax valid but complexity high",
  "warnings": [
    "Cyclomatic complexity: 15 (threshold: 10)",
    "Consider refactoring for better maintainability"
  ],
  "metadata": {
    "complexity": 15,
    "threshold": 10
  }
}
```

---

## Agent Coordination Workflow

How agents use hooks for coordination.

### Agent 1: Backend Developer

```bash
# STEP 1: Pre-task preparation
npx claude-flow hook pre-task \
  --description "Implement user authentication API" \
  --auto-spawn-agents \
  --load-memory

# STEP 2: Work begins - pre-edit validation
npx claude-flow hook pre-edit \
  --file "api/auth.js" \
  --auto-assign-agent \
  --validate-syntax

# STEP 3: Edit file (via Claude Code Edit tool)
# ... code changes ...

# STEP 4: Post-edit processing
npx claude-flow hook post-edit \
  --file "api/auth.js" \
  --memory-key "swarm/backend/auth-api" \
  --auto-format \
  --train-patterns

# STEP 5: Notify coordination system
npx claude-flow hook notify \
  --message "Auth API implementation complete" \
  --swarm-status \
  --broadcast

# STEP 6: Task completion
npx claude-flow hook post-task \
  --task-id "auth-api" \
  --analyze-performance \
  --store-decisions \
  --export-learnings
```

### Agent 2: Test Engineer (receives notification)

```bash
# STEP 1: Check memory for API details
npx claude-flow hook session-restore \
  --session-id "swarm-current" \
  --restore-memory

# Memory contains: swarm/backend/auth-api with implementation details

# STEP 2: Generate tests
npx claude-flow hook pre-task \
  --description "Write tests for auth API" \
  --load-memory

# STEP 3: Create test file
npx claude-flow hook post-edit \
  --file "api/auth.test.js" \
  --memory-key "swarm/testing/auth-api-tests" \
  --train-patterns

# STEP 4: Share test results
npx claude-flow hook notify \
  --message "Auth API tests complete - 100% coverage" \
  --broadcast
```

---

## Pre-Task Hook with Agent Spawning

```javascript
// Hook command
npx claude-flow hook pre-task --description "Build REST API"

// Internally calls MCP tools:
mcp__claude-flow__agent_spawn {
  type: "backend-dev",
  capabilities: ["api", "database", "testing"]
}

mcp__claude-flow__memory_usage {
  action: "store",
  key: "swarm/task/api-build/context",
  namespace: "coordination",
  value: JSON.stringify({
    description: "Build REST API",
    agents: ["backend-dev"],
    started: Date.now()
  })
}
```

---

## Session End Hook with State Persistence

```javascript
// Hook command
npx claude-flow hook session-end --session-id "dev-2024"

// Internally calls MCP tools:
mcp__claude-flow__memory_persist {
  sessionId: "dev-2024"
}

mcp__claude-flow__swarm_status {
  swarmId: "current"
}

// Generates metrics and summary
```
