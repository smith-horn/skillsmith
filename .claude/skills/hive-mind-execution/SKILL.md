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
│  0. EXPLORE       │  Discover existing code BEFORE implementing │
│  1. INITIALIZE    │  swarm_init with topology                   │
│  2. PLAN          │  TodoWrite with all tasks batched           │
│  3. EXECUTE       │  Parallel implementation                    │
│  4. REVIEW        │  Code review → docs/reviews/ (MANDATORY)    │
│  5. FIX           │  Address review findings                    │
│  5.5 GOVERNANCE   │  BLOCKING standards audit gate              │
│  6. DOCUMENT      │  ADR, Linear update, CLAUDE.md              │
│  7. SPRINT REPORT │  Summary of completed work & decisions      │
│  8. CLEANUP       │  swarm_destroy, mark issues done            │
└─────────────────────────────────────────────────────────────────┘

Key:
- Phase 0: MANDATORY - prevents duplicate work (see Wave 5 retro)
- Phase 4: Reviews written to docs/reviews/YYYY-MM-DD-<feature>.md
- Phase 7: Brief summary before cleanup (not a full retrospective)
- Linear issues: Must include details, links, and labels
```

## Phase 0: Exploration (MANDATORY)

**CRITICAL**: Before any implementation, discover what already exists. This prevents duplicate work and leverages existing code.

See [Exploration Phase Template](../../../docs/process/exploration-phase-template.md) for full details.

### Quick Exploration

```bash
# Search for existing implementations
grep -r "keyword" packages/
find packages/ -name "*feature*" -type f

# Check infrastructure
ls .github/workflows/
ls supabase/functions/

# Review architecture docs
ls docs/architecture/
ls docs/adr/
```

### Exploration Report

Document findings before proceeding:

```markdown
## Exploration Report: [Feature]

**Existing Implementation**: None / Partial / Complete
**Location**: [paths if found]
**Recommended Approach**: [based on what exists]
```

**Why This Matters**: In Wave 5, we discovered PostHog telemetry already existed but wasn't wired up. Exploration saved hours of duplicate work.

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

**MANDATORY**: Run code review after ANY code changes. Reviews are written to `docs/reviews/`.

### 4.1 Create Code Review Document

Write review to `docs/reviews/YYYY-MM-DD-<feature-or-issue>.md`:

```markdown
# Code Review: [Feature/Issue Name]

**Date**: YYYY-MM-DD
**Reviewer**: Claude Code Review Agent
**Related Issues**: SMI-XXX, SMI-YYY
**Files Changed**: X files

## Summary
[Brief description of changes reviewed]

## Files Reviewed
| File | Lines Changed | Status |
|------|---------------|--------|
| `src/path/file.ts` | +45/-12 | PASS |
| `tests/path/file.test.ts` | +30/-0 | PASS |

## Review Categories

### Security
- **Status**: PASS/WARN/FAIL
- **Findings**: [List any issues]
- **Recommendations**: [List fixes if needed]

### Error Handling
- **Status**: PASS/WARN/FAIL
- **Findings**: [List any issues]

### Backward Compatibility
- **Status**: PASS/WARN/FAIL
- **Breaking Changes**: [List if any]

### Best Practices
- **Status**: PASS/WARN/FAIL
- **Findings**: [List any issues]

### Documentation
- **Status**: PASS/WARN/FAIL
- **Missing Docs**: [List if any]

## Overall Result
- **PASS**: All checks passed, ready for merge
- **WARN**: Minor issues, can proceed with notes
- **FAIL**: Blocking issues must be fixed

## Action Items
| Item | Priority | Assignee |
|------|----------|----------|
| [Fix description] | High/Medium/Low | Developer |

## References
- [Related ADR](../adr/XXX-decision.md)
- [Standards Reference](../architecture/standards.md#section)
```

### 4.2 Spawn Code Review Agent

```javascript
Task({
  description: "Code review changes",
  prompt: `Review the following changes and write results to docs/reviews/:

    1. Security issues (env var handling, secrets exposure)
    2. Error handling completeness
    3. Backward compatibility
    4. Best practices adherence
    5. Documentation completeness

    IMPORTANT:
    - Write the full review to docs/reviews/YYYY-MM-DD-<feature>.md
    - Include links to relevant files and line numbers
    - Provide PASS/WARN/FAIL status for each category
    - List specific action items with priorities`,
  subagent_type: "general-purpose"
})
```

**Review Checklist**:
- [ ] Security: No hardcoded secrets, proper validation
- [ ] Error handling: Graceful failures, clear messages
- [ ] Compatibility: No breaking changes without documentation
- [ ] Best practices: TypeScript strict, proper typing
- [ ] Documentation: Comments where needed, types exported
- [ ] **Review document written to docs/reviews/**

## Phase 5: Fix Review Findings

Address any "Must Fix" items from review:

```javascript
// Fix issues identified in review
Edit("file.ts", old_string, new_string)

// Verify fixes
Bash("npm run typecheck && npm run lint")
```

### 5.1 Run Governance Audit

After addressing review findings, run the governance audit:

```bash
# Run governance standards check
docker exec skillsmith-dev-1 npm run audit:standards
```

This ensures all fixes meet engineering standards before proceeding.

## Phase 5.5: Governance Gate (BLOCKING)

**MANDATORY**: Before retrospective, verify all standards are met. **Workflow STOPS here until PASS.**

```javascript
// Invoke governance skill - BLOCKS until passing
Task({
  description: "Governance code review audit",  // Triggers PostToolUse hook
  prompt: `Run full governance check:
    1. Execute: docker exec skillsmith-dev-1 npm run audit:standards
    2. Verify all standards from standards.md are met
    3. Report PASS/FAIL with specific violations if any

    BLOCKING: Cannot proceed to Phase 6 until all checks PASS.
    If violations found, list specific files and fixes required.`,
  subagent_type: "general-purpose"
})
```

**Gate Requirements** (all must pass):
- [ ] No TypeScript strict mode violations
- [ ] All files under 500 lines
- [ ] 99%+ test coverage maintained
- [ ] No hardcoded secrets
- [ ] Conventional commit format ready

**On Failure**: Fix all violations, then re-run governance audit.

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

## Phase 7: Sprint Report

Generate a brief summary of the work completed before cleanup. This is NOT a retrospective—it's a quick status report.

### 7.1 Generate Sprint Report

Output a summary in the following format:

```markdown
## Sprint Report: [Issue/Feature Name]

**Date**: YYYY-MM-DD
**Issues**: SMI-XXX, SMI-YYY

### Completed Work

| Task | Status | Files Changed |
|------|--------|---------------|
| Implement feature X | ✅ Done | `src/x.ts`, `src/y.ts` |
| Add tests for X | ✅ Done | `tests/x.test.ts` |
| Update documentation | ✅ Done | `docs/x.md` |

### New Issues Created

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-XXX | [Brief title] | High |
| SMI-YYY | [Brief title] | Medium |

### Manual Steps & Decisions

| Decision/Step | Outcome |
|---------------|---------|
| User chose Option A for auth | Implemented JWT-based auth |
| Skipped optional feature Y | Deferred to next phase |
```

### 7.2 Present to User

Display the sprint report directly in the conversation. No file creation required unless the user requests it.

## Phase 8: Cleanup

```javascript
// Destroy swarm
mcp__claude-flow__swarm_destroy({ swarmId: "swarm_xxx" })

// Mark Linear issue done
Bash("npm run linear:done ENG-XXX")
```

## Quick Start Template

For executing a Linear issue with hive mind:

```
0. EXPLORE: Search codebase for existing implementations (MANDATORY)
1. Read the Linear issue: ENG-XXX
2. Initialize hive mind: swarm_init({ topology: "hierarchical" })
3. Create todos: TodoWrite with all tasks from issue
4. Execute in parallel where possible
5. Run code review with Task agent
6. Fix any "Must Fix" items
7. Run governance audit
8. Create ADR if architectural decision
9. Create Linear project update
10. Update CLAUDE.md if new patterns
11. Generate sprint report (summary table, new issues, decisions)
12. Cleanup: swarm_destroy, linear:done
```

**Process Documents**:
- [Wave Completion Checklist](../../../docs/process/wave-completion-checklist.md) - Pre/post commit verification
- [Exploration Phase Template](../../../docs/process/exploration-phase-template.md) - Discover existing code
- [Infrastructure Inventory](../../../docs/architecture/infrastructure-inventory.md) - What exists in the codebase

## Example: Execute ENG-123

```
User: execute ENG-123 with hive mind

Claude:
1. [Read ENG-123 to understand tasks]
2. [swarm_init with hierarchical topology]
3. [TodoWrite with 8 tasks from issue]
4. [Parallel edits to relevant files]
5. [Task agent for code review]
6. [Fix any review findings]
7. [Run governance audit]
8. [Create ADR if needed]
9. [Create Linear project update]
10. [Update CLAUDE.md if new patterns]
11. [Display sprint report with completed work table]
12. [swarm_destroy, linear:done ENG-123]
```

## Best Practices

### DO
- Batch all todos in single TodoWrite call
- Execute independent tasks in parallel
- Run code review after implementation
- Document lessons learned in ADR
- Update Linear with project status
- **ALWAYS run code review before any commit/push**

### DON'T
- Create todos one at a time
- Execute sequentially when parallel is possible
- Skip code review
- Leave documentation stale
- Forget to mark issues done
- **NEVER commit or push without completing code review first**

## ⚠️ MANDATORY: Code Review Before Push

**CRITICAL REQUIREMENT**: Always run a code review before committing or pushing any changes.

### Code Review Gate

Before ANY commit or push operation, you MUST:

1. **Run typecheck**: `docker exec skillsmith-dev-1 npm run typecheck`
2. **Run tests**: `docker exec skillsmith-dev-1 npm test`
3. **Execute code review** using the [GitHub Code Review Skill](../github-code-review/SKILL.md)

### Code Review Checklist

```javascript
// REQUIRED before commit/push
Task({
  description: "Code review before push",
  prompt: `Perform comprehensive code review:

    ## Security
    - [ ] No hardcoded secrets or API keys
    - [ ] Proper input validation
    - [ ] No SQL injection vulnerabilities
    - [ ] SSRF/path traversal prevention

    ## Quality
    - [ ] All tests pass
    - [ ] TypeScript strict compliance
    - [ ] Error handling complete
    - [ ] No breaking changes without documentation

    ## Documentation
    - [ ] Public APIs documented
    - [ ] ADR created for architectural decisions
    - [ ] Linear issues updated

    Provide: PASS, WARN (with items), or FAIL (with blockers)`,
  subagent_type: "general-purpose"
})
```

### Review Status Requirements

| Status | Can Push? | Action Required |
|--------|-----------|-----------------|
| PASS | ✅ Yes | Proceed with commit/push |
| WARN | ⚠️ Conditional | Fix warnings or document as known issues |
| FAIL | ❌ No | Must fix blockers before push |

### Quick Review Command

```bash
# Run quick pre-push checks
docker exec skillsmith-dev-1 npm run typecheck && \
docker exec skillsmith-dev-1 npm test && \
echo "✅ Ready for code review"
```

See [GitHub Code Review Skill](../github-code-review/SKILL.md) for detailed review patterns.

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
