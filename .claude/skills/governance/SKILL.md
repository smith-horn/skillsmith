---
name: "Governance"
description: "Enforces engineering standards and code quality policies. Use during code reviews, before commits, when discussing standards or compliance, and for quality audits."
---

# Governance Skill

Enforces engineering standards from [standards.md](../../../docs/architecture/standards.md) during development.

## Trigger Phrases

- "code review", "review this"
- "commit", "before I merge"
- "standards", "compliance"
- "code quality", "best practices"

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
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run audit:standards
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

When performing a code review:

1. **Identify ALL issues** - Critical, major, and minor severity
2. **For EACH issue, immediately do ONE of:**
   - **Fix it now** - Implement the fix before moving on
   - **Create a Linear issue** - If deferring, create the issue IMMEDIATELY
3. **No "deferred" without a ticket** - "Deferred" without documentation = forgotten
4. **Re-review after fixes** - Verify each fix addresses the issue

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

### Severity Guide

| Severity | Action | Examples |
|----------|--------|----------|
| Critical | Fix before merge | Security vulnerabilities, data loss risks |
| Major | Fix OR create issue before merge | Missing tests, type safety issues |
| Minor | Fix OR create issue before merge | Style inconsistencies, minor refactors |

**Every issue gets either a fix or a Linear ticket. No exceptions.**

### Code Review Completion Checklist

Before marking a code review complete:

- [ ] All critical issues fixed
- [ ] All major issues either fixed OR have Linear tickets
- [ ] All minor issues either fixed OR have Linear tickets
- [ ] Each deferred issue has a ticket number documented
- [ ] Re-review confirms fixes are correct

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

## Git Hooks

A pre-commit hook is available to warn about untracked files in `packages/*/src/`:

```bash
# Install the hook
cp scripts/git-hooks/pre-commit-check-src.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

See [scripts/git-hooks/README.md](../../../scripts/git-hooks/README.md) for details.
