---
name: "Governance"
description: "Enforces engineering standards and code quality policies. Use during code reviews, before commits, when discussing standards or compliance, and for quality audits."
---

# Governance Skill

## Behavioral Classification

**Type**: Autonomous Execution (ADR-025)

This skill executes automatically without asking for permission. When triggered during code review:
1. All issues are identified (critical, major, minor)
2. Each issue is immediately actioned: **fixed** or **Linear ticket created**
3. Results are reported

**Anti-pattern**: "Would you like me to fix these issues?"
**Correct pattern**: "Found 5 issues. Fixing 2 high-severity now. Created SMI-1234, SMI-1235 for 3 medium/low."

---

Enforces engineering standards from [standards.md](../../../docs/architecture/standards.md) during development.

## Trigger Phrases

- "code review", "review this"
- "commit", "before I merge"
- "standards", "compliance"
- "code quality", "best practices"
- "retro", "retrospective"

## Quick Audit

Run the standards audit (in Docker):

```bash
docker exec skillsmith-dev-1 npm run audit:standards
```

## Pre-Commit Checklist

Before every commit, run these in Docker:

```bash
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm run lint
docker exec skillsmith-dev-1 npm run format:check  # Catch formatting before CI
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run audit:standards
```

### Pre-Push Verification

Before pushing, verify no source files are missing from commits:

```bash
# Check for untracked source files (common CI failure cause)
git status --short | grep "^??" | grep -E "packages/.*/src/"

# If any appear, they likely need to be staged and committed!
```

For the complete wave completion checklist, see [docs/process/wave-completion-checklist.md](../../../docs/process/wave-completion-checklist.md).

## Two-Document Model

| Document | Purpose | Location |
|----------|---------|----------|
| CLAUDE.md | AI operational context | Project root |
| standards.md | Engineering policy (authoritative) | docs/architecture/ |

## Key Standards Reference

### Code Quality (§1)

- **TypeScript strict mode** - No `any` without justification
- **500 line limit** - Split larger files
- **JSDoc for public APIs**
- **Co-locate tests** (`*.test.ts`)

### Type Safety Patterns (Code Review Focus)

Common type errors to catch during review:

| Pattern | Issue | Fix |
|---------|-------|-----|
| `null` vs `undefined` | Return type mismatch | Use consistent nullish type |
| `as any` cast | Type safety bypass | Use proper generic or type guard |
| Missing `\| undefined` | Optional field not typed | Add to type definition |

**Example fix for null/undefined mismatch:**
```typescript
// BAD: cache is null but return type is undefined
let cache: Data | null = null
function get(): Data | undefined { return cache }  // TS2322!

// GOOD: Use Symbol for uninitialized state
const NOT_LOADED = Symbol('not-loaded')
let cache: Data | undefined | typeof NOT_LOADED = NOT_LOADED
function get(): Data | undefined {
  return cache === NOT_LOADED ? undefined : cache
}
```

### Testing (§2)

- **80% unit coverage** (90% for MCP tools)
- **Tests alongside code**
- **Mock external services only**

### Workflow (§3)

- **Docker-first** - All commands via `docker exec skillsmith-dev-1`
- **Trunk-based development** - Short-lived feature branches
- **Conventional commits** - `<type>(scope): <description>`

### Security (§4)

- **No hardcoded secrets**
- **Validate all input** - Zod at boundaries
- **Prototype pollution checks** - Before JSON.parse
- **Safe subprocess spawning** - execFile with arrays

## Automated Checks

The `npm run audit:standards` command verifies:

- [ ] Docker command usage in scripts
- [ ] File length under 500 lines
- [ ] No console.log statements
- [ ] Import organization
- [ ] Test file coverage

## Code Review Workflow

**IMPORTANT: All issues require resolution OR tracking before PR merge.**

**⚠️ EXECUTE, DON'T ASK**: This workflow is mandatory. Do NOT ask "would you like me to fix these?" or "should I create Linear tickets?" - just execute the workflow. The user expects you to follow governance automatically.

When performing a code review:

1. **Identify ALL issues** - Critical, major, and minor severity
2. **For EACH issue, immediately do ONE of:**
   - **Fix it now** - Implement the fix before moving on
   - **Create a Linear issue** - If deferring, create the issue IMMEDIATELY
3. **No "deferred" without a ticket** - "Deferred" without documentation = forgotten
4. **Re-review after fixes** - Verify each fix addresses the issue

**Anti-pattern (NEVER do this):**
> "I found 5 issues. Would you like me to fix them or create tickets?"

**Correct pattern:**
> "Found 5 issues. Fixing 2 high-severity now. Creating Linear tickets for 3 medium/low."

### The Deferred Issue Rule

**"Deferred" is not a resolution. A Linear issue number is.**

When you identify an issue that won't be fixed in the current PR:
1. Stop what you're doing
2. Create the Linear sub-issue immediately
3. Note the issue number (e.g., SMI-1234) in your review
4. Only then continue with the review

```bash
# Create sub-issue immediately when deferring
npx tsx ~/.claude/skills/linear/scripts/linear-ops.ts create-sub-issue SMI-XXX "Issue title" "Description" --priority 3
```

**Anti-pattern (NEVER do this):**
> "This is a minor issue, we can address it later."

**Correct pattern:**
> "Created SMI-1234 to track this. Deferring to post-merge."

### Issue Creation Template

```
Title: [Code Review] <brief description>
Description:
- File: <path>
- Line: <number>
- Issue: <what's wrong>
- Fix: <suggested resolution>
- Standard: §<section> from standards.md
```

### Severity Guide (SMI-1726)

| Severity | Action | Examples |
|----------|--------|----------|
| Critical | Fix before merge (blocking) | Security vulnerabilities, data loss risks |
| High | Fix before merge (blocking) | Missing tests, type safety issues |
| Medium | **Fix OR create Linear issue** | Architecture issues, style problems |
| Low | **Fix OR create Linear issue** | Minor refactors, documentation gaps |

**🚨 MANDATORY: Every finding gets either a fix or a Linear ticket. No exceptions.**

```bash
# Create Linear issue for non-blocking finding
node ~/.claude/skills/linear/scripts/linear-api.mjs create-issue \
  --team SMI \
  --title "[Code Review] Finding title" \
  --description "Details..." \
  --priority 3  # 3=medium, 4=low
```

### Code Review Completion Checklist

Before marking a code review complete:

- [ ] All critical issues fixed
- [ ] All major issues either fixed OR have Linear tickets
- [ ] All minor issues either fixed OR have Linear tickets
- [ ] Each deferred issue has a ticket number documented
- [ ] Re-review confirms fixes are correct
- [ ] **Code review report written to `docs/code_review/`**

### Code Review Report (Mandatory)

**Every code review MUST produce a written report** saved to `docs/code_review/`.

**File naming**: `YYYY-MM-DD-<brief-slug>.md`
**Example**: `2025-01-24-auth-refactor-review.md`

**Template**:

```markdown
# Code Review: <Title>

**Date**: YYYY-MM-DD
**Reviewer**: Claude Code Review Agent
**Related Issues**: SMI-XXX
**Files Changed**: N files

## Summary

Brief description of what was reviewed.

## Files Reviewed

| File | Lines Changed | Status | Notes |
|------|---------------|--------|-------|
| `path/to/file.ts` | +X/-Y | PASS/FAIL | Brief note |

## Findings

| Finding | Severity | Status |
|---------|----------|--------|
| Description | Critical/High/Medium/Low | Fixed/Created SMI-XXX |

## Overall Result

**PASS/FAIL**: Summary of review outcome.

## Recommendations (Non-Blocking)

- Recommendation 1
- Recommendation 2
```

---

## Retrospective Reports

When running a retrospective ("retro"), **MUST produce a written report** saved to `docs/retros/`.

**File naming**: `YYYY-MM-DD-<topic-slug>.md`
**Example**: `2025-01-24-auth-migration-retro.md`

**Template**:

```markdown
# <Topic> Retrospective

**Date:** YYYY-MM-DD
**Duration:** N sessions
**Issues Completed:** SMI-XXX, SMI-YYY
**Branch:** `branch-name`

## What Went Well

1. Item 1
2. Item 2

## What Went Wrong

1. Issue 1
2. Issue 2

## Metrics

| Metric | Value |
|--------|-------|
| Files modified | N |
| Tests passing | N/N |
| Issues found | N |

## Key Lessons

1. Lesson 1
2. Lesson 2

## Recommendations

1. Recommendation for future work
```

### Retrospective Completion Checklist

- [ ] All completed issues listed with SMI numbers
- [ ] "What Went Well" has at least 2 items
- [ ] "What Went Wrong" is honest (even if brief)
- [ ] Metrics are accurate
- [ ] Key lessons are actionable
- [ ] **Report written to `docs/retros/`**

---

## When to Invoke

This skill activates automatically during:

1. **Code reviews** - Creates Linear issues for ALL findings
2. **Pre-commit** - Reminds about checklist
3. **Quality discussions** - References authoritative standards

## Full Standards

For complete policy details, see [docs/architecture/standards.md](../../../docs/architecture/standards.md).

## Related Process Documents

| Document | Purpose |
|----------|---------|
| [Wave Completion Checklist](../../../docs/process/wave-completion-checklist.md) | Pre/post commit verification steps |
| [Exploration Phase Template](../../../docs/process/exploration-phase-template.md) | Discover existing code before implementing |
| [Linear Hygiene Guide](../../../docs/process/linear-hygiene-guide.md) | Prevent duplicate issues |
| [Infrastructure Inventory](../../../docs/architecture/infrastructure-inventory.md) | What exists in the codebase |

## Common CI Failures

Patterns that pass locally but fail in CI:

| Failure | Root Cause | Prevention |
|---------|------------|------------|
| `Cannot find module './foo.types.js'` | New files created but not committed | Run `git status` before push |
| Prettier formatting errors | Formatting not run locally | Add `format:check` to pre-commit |
| `TS2322: Type 'null' not assignable` | null vs undefined mismatch | Use consistent nullish types |
| Native module errors | Missing rebuild after install | Run `npm rebuild` in Docker |

## Git Hooks

A pre-commit hook is available to warn about untracked files in `packages/*/src/`:

```bash
# Install the hook
cp scripts/git-hooks/pre-commit-check-src.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

See [scripts/git-hooks/README.md](../../../scripts/git-hooks/README.md) for details.
