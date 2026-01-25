# Code Review Report Template

**Location**: `docs/code_review/YYYY-MM-DD-<brief-slug>.md`

**Example filename**: `2025-01-24-auth-refactor-review.md`

---

## Template

```markdown
# Code Review: <Title>

**Date**: YYYY-MM-DD
**Reviewer**: Claude Code Review Agent
**Related Issues**: SMI-XXX
**Files Changed**: N files
**Docker Validated**: Yes/No

## Summary

Brief description of what was reviewed.

## Pre-Review Checks

| Check | Status |
|-------|--------|
| `npm run typecheck` | PASS/FAIL |
| `npm run lint` | PASS/FAIL |
| `npm run test` | PASS/FAIL |
| `npm run audit:standards` | PASS/FAIL |

## Files Reviewed

| File | Lines Changed | Status | Notes |
|------|---------------|--------|-------|
| `path/to/file.ts` | +X/-Y | PASS/FAIL | Brief note |

## Findings

| Finding | Severity | Standard | Status |
|---------|----------|----------|--------|
| Description | Critical/High/Medium/Low | §N | Fixed/SMI-XXX |

## CI Impact Assessment

- [ ] No new ESLint warnings introduced
- [ ] TypeScript strict mode satisfied
- [ ] Tests maintain >80% coverage
- [ ] No native module changes requiring rebuild

## Overall Result

**PASS/FAIL**: Summary of review outcome.

## Linear Issues Created

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-XXX | Description | P2/P3/P4 |

## Recommendations (Non-Blocking)

- Recommendation 1
- Recommendation 2
```

---

## Field Descriptions

| Field | Required | Description |
|-------|----------|-------------|
| **Date** | Yes | Review date (YYYY-MM-DD) |
| **Reviewer** | Yes | Who performed the review |
| **Related Issues** | Yes | Linear issue numbers |
| **Files Changed** | Yes | Count of files reviewed |
| **Docker Validated** | Yes | Whether commands ran in Docker |
| **Pre-Review Checks** | Yes | All 4 checks must be run |
| **Findings** | Yes | Even if empty, document it |
| **CI Impact Assessment** | Yes | All 4 checkboxes must be addressed |
| **Linear Issues Created** | If applicable | Deferred issues must have tickets |

## Severity Guide

| Severity | Action | Examples |
|----------|--------|----------|
| Critical | Fix before merge (blocking) | Security vulnerabilities, data loss risks |
| High | Fix before merge (blocking) | Missing tests, type safety issues |
| Medium | Fix OR create Linear issue | Architecture issues, style problems |
| Low | Fix OR create Linear issue | Minor refactors, documentation gaps |

## Standard References

The **Standard** column (§N) references sections from [standards.md](../../../docs/architecture/standards.md):
- §1 - Code Quality
- §2 - Testing
- §3 - Workflow
- §4 - Security

---

**See also**: [SKILL.md](SKILL.md) | [retro-template.md](retro-template.md)
