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

## Retrospective Next Steps

After writing retrospective, **ALWAYS** ask user:

```javascript
AskUserQuestion({
  questions: [{
    question: "How would you like to handle the next steps?",
    header: "Next Steps",
    options: [
      { label: "Add all to Linear", description: "Create issues for all next steps" },
      { label: "Select which to add", description: "Choose which items to create" },
      { label: "Skip for now", description: "Document only, no issues" }
    ]
  }]
})
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
- [ ] **Retrospective written**
- [ ] **User prompted for next steps**
- [ ] ADR created (if needed)
- [ ] Linear updated
- [ ] CLAUDE.md updated (high-level only!)
- [ ] Swarm destroyed
- [ ] Issue marked done
