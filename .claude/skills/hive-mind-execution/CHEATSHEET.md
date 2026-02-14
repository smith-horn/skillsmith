# Hive Mind Execution Cheatsheet

## Quick Commands

```bash
# Initialize swarm
mcp__claude-flow__swarm_init({ topology: "hierarchical", maxAgents: 6 })

# Destroy swarm
mcp__claude-flow__swarm_destroy({ swarmId: "swarm_xxx" })

# Mark Linear issue done
npm run linear:done ENG-XXX
```

## TodoWrite Pattern

```javascript
// ALWAYS batch all todos in ONE call
TodoWrite([
  { content: "Task 1", status: "in_progress", activeForm: "Doing task 1" },
  { content: "Task 2", status: "pending", activeForm: "Doing task 2" },
  { content: "Task 3", status: "pending", activeForm: "Doing task 3" },
  { content: "Code review", status: "pending", activeForm: "Reviewing code" },
  { content: "Documentation", status: "pending", activeForm: "Updating docs" }
])
```

## Parallel Execution Pattern

```javascript
// Single message with independent operations
[Parallel]:
  Edit("file1.ts", old, new)
  Edit("file2.ts", old, new)
  Write("file3.ts", content)
```

## Code Review Prompt

```
Review changes for:
1. Security (secrets, validation)
2. Error handling (graceful failures)
3. Compatibility (breaking changes)
4. Best practices (TypeScript, typing)
5. Documentation (comments, exports)

Provide PASS/WARN/FAIL for each.
```

## Linear Project Update

```javascript
// GraphQL
mutation {
  projectUpdateCreate(input: {
    projectId: "UUID",
    body: "## Summary\n- Done 1\n- Done 2"
  }) { success }
}
```

## ADR Quick Template

```markdown
# ADR-0XX: Title

**Status**: Accepted
**Date**: YYYY-MM-DD
**Related Issues**: ENG-XXX

## Context
[Problem]

## Decision
[Solution]

## Consequences
### Positive
### Negative

## Lessons Learned
[Pattern for future]
```

## Topology Guide

| Topology | Use When |
|----------|----------|
| hierarchical | Complex with dependencies |
| mesh | Independent parallel |
| star | Central coordinator |
| ring | Sequential pipeline |

## Sprint Report Template

Display before cleanup:

```markdown
## Sprint Report: [Feature]

### Completed Work
| Task | Status | Files |
|------|--------|-------|
| Feature X | ✅ Done | `src/x.ts` |

### New Issues Created
| Issue | Title | Priority |
|-------|-------|----------|
| SMI-XXX | Title | High |

### Manual Steps & Decisions
| Decision | Outcome |
|----------|---------|
| User chose X | Did Y |
```

## CLAUDE.md Policy

Keep CLAUDE.md **HIGH-LEVEL**:
- 1-2 sentences max per feature
- Always link to skill/ADR for details
- Details → Skills, ADRs, or docs/
- **NEVER** document env vars in markdown (use `.env.schema`)

## Checklist

- [ ] Swarm initialized
- [ ] Todos batched in one call
- [ ] Parallel execution used
- [ ] Code review completed
- [ ] Review fixes applied
- [ ] Governance audit passed
- [ ] ADR created (if needed)
- [ ] Linear updated
- [ ] CLAUDE.md updated (high-level only!)
- [ ] **Sprint report displayed**
- [ ] Swarm destroyed
- [ ] Issue marked done
