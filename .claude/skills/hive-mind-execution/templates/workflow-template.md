# Hive Mind Execution Workflow Template

Use this template when executing Linear issues or complex tasks with hive mind.

## Pre-Execution Checklist

- [ ] Linear issue ID identified (e.g., SMI-XXX)
- [ ] Tasks/requirements understood
- [ ] Dependencies identified
- [ ] Estimated scope (small/medium/large)

## Execution Steps

### Step 1: Initialize

```
Command: Initialize hive mind swarm
Topology: [hierarchical | mesh | star | ring]
Max Agents: [4-8]
Strategy: balanced
```

### Step 2: Plan

```
Tasks to execute:
1. [ ] Task 1: [description]
2. [ ] Task 2: [description]
3. [ ] Task 3: [description]
...
N. [ ] Code review
N+1. [ ] Documentation updates
```

### Step 3: Execute

| Task | Parallel? | Dependencies | Status |
|------|-----------|--------------|--------|
| Task 1 | Yes | None | |
| Task 2 | Yes | None | |
| Task 3 | No | Task 1, 2 | |

### Step 4: Code Review Findings

| Category | Status | Issues | Action |
|----------|--------|--------|--------|
| Security | | | |
| Error Handling | | | |
| Compatibility | | | |
| Best Practices | | | |
| Documentation | | | |

### Step 5: Documentation

- [ ] ADR created/updated: `docs/adr/0XX-title.md`
- [ ] ADR index updated: `docs/adr/index.md`
- [ ] Linear project update created
- [ ] CLAUDE.md updated (if applicable)

### Step 6: Cleanup

- [ ] Swarm destroyed
- [ ] Linear issue marked done
- [ ] Branch merged (if applicable)

## Post-Execution

### Lessons Learned

What patterns emerged that should be documented?

```
Pattern: [name]
Problem: [what issue did we solve]
Solution: [what approach worked]
Apply when: [future scenarios]
```

### Metrics

| Metric | Value |
|--------|-------|
| Tasks completed | /N |
| Code review findings | X |
| Time elapsed | Xm |
| Files changed | X |

## Template Variables

Replace these when using:

- `{ISSUE_ID}` - Linear issue (e.g., SMI-851)
- `{PROJECT_ID}` - Linear project UUID
- `{PHASE}` - Phase number (e.g., 4)
- `{ADR_NUMBER}` - Next ADR number
