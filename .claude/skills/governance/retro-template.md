# Retrospective Report Template

**Location**: `docs/retros/YYYY-MM-DD-<topic-slug>.md`

**Example filename**: `2025-01-24-auth-migration-retro.md`

---

## Template

```markdown
# <Topic> Retrospective

**Date:** YYYY-MM-DD
**Duration:** N waves / N sessions
**Issues Completed:** SMI-XXX, SMI-YYY
**PRs Updated:** #N
**Branch:** `feature/branch-name` (worktree-based)

---

## What Went Well

1. (e.g., "Worktree isolation - Clean separation from main branch")
2. (e.g., "Hive mind orchestration - Research agents gathered context before coding")
3.

---

## What Went Wrong

1. (e.g., "Docker container needed rebuild after npm install")
2. (e.g., "Context compaction mid-session")

---

## Metrics

| Metric | Value |
|--------|-------|
| Files modified | N |
| Tests passing | N/N |
| Code review issues found | N |
| Code review issues fixed | N |

---

## Breaking Changes (if applicable)

| Component | Breaking Change | Resolution |
|-----------|-----------------|------------|
| Package/API | What changed | How we handled it |

---

## Code Review Findings (per wave)

### Wave N: <Description>

| Finding | Severity | Resolution |
|---------|----------|------------|
| Description | Critical/High/Medium/Low | Fixed/Created SMI-XXX |

---

## Waves Summary (if multi-wave)

| Wave | Issue | Scope | Commits |
|------|-------|-------|---------|
| 1 | SMI-XXX | Description | abc1234 |

---

## Key Lessons

1. (Actionable, e.g., "Query npm registry for versions - Don't assume version numbers")
2.

---

## Recommendations for Future Work

1. (Forward-looking, e.g., "Run preflight in Docker between waves")
2.
```

---

## Section Descriptions

| Section | Required | Description |
|---------|----------|-------------|
| **Header** | Yes | Date, duration, issues, PRs, branch |
| **What Went Well** | Yes | Minimum 2 items |
| **What Went Wrong** | Yes | Be honest, even if brief |
| **Metrics** | Yes | Quantitative outcomes |
| **Breaking Changes** | If applicable | Document any breaking changes |
| **Code Review Findings** | If applicable | Per-wave breakdown |
| **Waves Summary** | If multi-wave | Links issues to commits |
| **Key Lessons** | Yes | Actionable learnings |
| **Recommendations** | Yes | Forward-looking guidance |

## Completion Checklist

Before saving your retrospective:

- [ ] All completed issues listed with SMI numbers
- [ ] PRs and branch documented
- [ ] "What Went Well" has at least 2 items
- [ ] "What Went Wrong" is honest (even if brief)
- [ ] Metrics are accurate (including code review findings)
- [ ] Key lessons are actionable
- [ ] Breaking changes documented (if applicable)
- [ ] **Report written to `docs/retros/`**

## Common Patterns

### Duration Formats
- Single session: `1 session`
- Multiple sessions: `3 sessions`
- Wave-based: `2 waves`
- Mixed: `2 waves / 4 sessions`

### Metric Examples
- Files modified: `23`
- Tests passing: `4991/4991`
- Code review issues found: `5`
- Code review issues fixed: `5`

---

**See also**: [SKILL.md](SKILL.md) | [code-review-template.md](code-review-template.md)
