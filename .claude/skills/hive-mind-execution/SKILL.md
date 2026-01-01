---
name: "Hive Mind Execution"
description: "Execute Linear issues or tasks using hive mind orchestration with parallel agents, code review, and documentation updates. Use for phase execution, epic completion, or complex multi-task work."
---

# Hive Mind Execution Skill

Orchestrates complex task execution using claude-flow hive mind with automatic code review and documentation updates.

## Trigger Phrases

- "execute SMI-xxx with hive mind"
- "run phase X with hive mind"
- "execute this epic"
- "orchestrate these tasks"
- "parallel execution with review"

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    HIVE MIND EXECUTION                          │
├─────────────────────────────────────────────────────────────────┤
│  1. INITIALIZE    │  swarm_init with topology                   │
│  2. PLAN          │  TodoWrite with all tasks batched           │
│  3. EXECUTE       │  Parallel implementation                    │
│  4. REVIEW        │  Code review with Task agent                │
│  5. FIX           │  Address review findings                    │
│  6. DOCUMENT      │  ADR, Linear update, CLAUDE.md              │
│  7. CLEANUP       │  swarm_destroy, mark issues done            │
└─────────────────────────────────────────────────────────────────┘
```

## Phase 1: Initialize Hive Mind

```javascript
// Initialize swarm with appropriate topology
mcp__claude-flow__swarm_init({
  topology: "hierarchical",  // or "mesh", "ring", "star"
  maxAgents: 6,
  strategy: "balanced"
})
```

**Topology Selection Guide**:

| Topology | Use Case |
|----------|----------|
| `hierarchical` | Complex epics with dependencies |
| `mesh` | Independent parallel tasks |
| `star` | Central coordinator with workers |
| `ring` | Sequential pipeline processing |

## Phase 2: Plan with TodoWrite

**CRITICAL**: Batch ALL todos in a single call:

```javascript
TodoWrite([
  { content: "Task 1 description", status: "in_progress", activeForm: "Working on task 1" },
  { content: "Task 2 description", status: "pending", activeForm: "Working on task 2" },
  { content: "Task 3 description", status: "pending", activeForm: "Working on task 3" },
  // ... all tasks
  { content: "Run code review", status: "pending", activeForm: "Running code review" },
  { content: "Update documentation", status: "pending", activeForm: "Updating documentation" }
])
```

## Phase 3: Parallel Execution

Execute independent tasks in parallel using file operations:

```javascript
// Single message with all parallel operations
[Parallel]:
  Edit("file1.ts", changes)
  Edit("file2.ts", changes)
  Write("new-file.ts", content)
  Bash("npm run typecheck")
```

**Rules**:
- Group independent operations in single message
- Update TodoWrite status as tasks complete
- Mark tasks `completed` immediately when done

## Phase 4: Code Review

Spawn a code review agent after implementation:

```javascript
Task({
  description: "Code review changes",
  prompt: `Review the following changes for:
    1. Security issues (env var handling, secrets exposure)
    2. Error handling completeness
    3. Backward compatibility
    4. Best practices adherence
    5. Documentation completeness

    Provide PASS/WARN/FAIL status for each.`,
  subagent_type: "general-purpose"
})
```

**Review Checklist**:
- [ ] Security: No hardcoded secrets, proper validation
- [ ] Error handling: Graceful failures, clear messages
- [ ] Compatibility: No breaking changes without documentation
- [ ] Best practices: TypeScript strict, proper typing
- [ ] Documentation: Comments where needed, types exported

## Phase 5: Fix Review Findings

Address any "Must Fix" items from review:

```javascript
// Fix issues identified in review
Edit("file.ts", old_string, new_string)

// Verify fixes
Bash("npm run typecheck && npm run lint")
```

## Phase 6: Documentation Updates

### 6.1 Create/Update ADR (if architectural decision)

```markdown
# ADR-0XX: [Title]

**Status**: Accepted
**Date**: YYYY-MM-DD
**Related Issues**: SMI-XXX

## Context
[Problem that motivated the decision]

## Decision
[What we decided and why]

## Consequences
### Positive
### Negative
### Neutral

## Lessons Learned
[Pattern for future reference]
```

### 6.2 Update ADR Index

```javascript
Edit("docs/adr/index.md",
  "| [ADR-011]...",
  "| [ADR-011]...\n| [ADR-012](012-new-adr.md) | Title | Accepted | DATE |"
)
```

### 6.3 Create Linear Project Update

```javascript
// GraphQL mutation for project update
mutation {
  projectUpdateCreate(input: {
    projectId: "PROJECT_ID",
    body: "## Summary\n\n### Completed\n- Item 1\n- Item 2"
  }) {
    success
    projectUpdate { url }
  }
}
```

### 6.4 Update CLAUDE.md (High-Level Only)

**Policy**: CLAUDE.md should remain high-level. Push details to skills/ADRs.

**What belongs in CLAUDE.md**:
- New command (1 line) + link to skill/doc
- Brief pointer to new capability (1-2 sentences max)

**What does NOT belong**:
- Detailed usage instructions → Skill
- Decision rationale → ADR
- Configuration options → `.env.schema` or skill
- Environment variables → `.env.schema` (security risk in markdown)
- Examples beyond 1-2 lines → Skill

**Template for CLAUDE.md updates**:

```markdown
### [Feature Name]

Brief description. See [Skill Name](path/to/SKILL.md) for details.
```

**Security**: Never document env var values in markdown. Reference `.env.schema` instead.

## Phase 7: Cleanup

```javascript
// Destroy swarm
mcp__claude-flow__swarm_destroy({ swarmId: "swarm_xxx" })

// Mark Linear issue done
Bash("npm run linear:done SMI-XXX")
```

## Quick Start Template

For executing a Linear issue with hive mind:

```
1. Read the Linear issue: SMI-XXX
2. Initialize hive mind: swarm_init({ topology: "hierarchical" })
3. Create todos: TodoWrite with all tasks from issue
4. Execute in parallel where possible
5. Run code review with Task agent
6. Fix any "Must Fix" items
7. Create ADR if architectural decision
8. Create Linear project update
9. Update CLAUDE.md if new patterns
10. Cleanup: swarm_destroy, linear:done
```

## Example: Execute SMI-851

```
User: execute SMI-851 with hive mind

Claude:
1. [Read SMI-851 to understand tasks]
2. [swarm_init with hierarchical topology]
3. [TodoWrite with 8 tasks from issue]
4. [Parallel edits to run.sh, config.ts, docker-compose.yml, etc.]
5. [Task agent for code review]
6. [Fix NODE_ENV mismatch, add parseIntSafe]
7. [Create ADR-012: Native Module Version Management]
8. [Create Linear project update]
9. [Update CLAUDE.md with orchestrator docs]
10. [swarm_destroy, linear:done SMI-851]
```

## Best Practices

### DO
- Batch all todos in single TodoWrite call
- Execute independent tasks in parallel
- Run code review after implementation
- Document lessons learned in ADR
- Update Linear with project status

### DON'T
- Create todos one at a time
- Execute sequentially when parallel is possible
- Skip code review
- Leave documentation stale
- Forget to mark issues done

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `LINEAR_API_KEY` | Linear API access for updates |
| `LINEAR_PROJECT_ID` | Target project for updates |

### Dependencies

- claude-flow (local devDependency)
- Linear API access
- Docker (for consistent execution)

## Hive Mind Orchestrator Commands

### Docker Execution (Recommended)

```bash
docker compose --profile orchestrator up

# With options
docker compose --profile orchestrator run --rm orchestrator \
  npx tsx scripts/phase4-orchestrator/orchestrator.ts --dry-run
```

### Local Execution

```bash
cd scripts/phase4-orchestrator
./run.sh              # Full execution
./run.sh --dry-run    # Preview without changes
./run.sh --start-from 2  # Resume from epic 2
```

> **Note**: Local execution requires Node.js 22+. Run `npm rebuild` after Node version changes.

### Environment Variables

Environment variables are defined in `.env.schema` and managed via Varlock.
See `skillsmith/.env.schema` for available variables.

**Never document env var values in markdown files.**

## Related Skills

- [Governance](../governance/SKILL.md) - Standards enforcement
- [Swarm Orchestration](../swarm-orchestration/SKILL.md) - Advanced swarm patterns
- [Worktree Manager](../worktree-manager/SKILL.md) - Parallel development

## References

- [ADR-012: Native Module Version Management](../../../docs/adr/012-native-module-version-management.md)
- [claude-flow Documentation](https://github.com/ruvnet/claude-flow)
- [Linear API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api)
