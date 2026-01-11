# Linear Issue Hygiene Guide

> **Purpose**: Prevent duplicate issues and maintain backlog quality
> **Audience**: All contributors to Skillsmith
> **Created**: January 8, 2025
> **Trigger**: SMI-1185 (GitHub Indexer Workflow) was discovered to duplicate existing implementation

---

## Background

During routine backlog review, SMI-1185 was identified as a duplicate of work already completed. The GitHub Indexer Workflow had been fully implemented in `.github/workflows/github-indexer.yml` but remained as an open issue. This guide establishes practices to prevent similar occurrences.

---

## Before Creating New Issues

### 1. Search Existing Linear Issues

Before creating any new issue:

```bash
# Check your Linear access
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts whoami
```

In Linear UI:
- Search by primary keywords (e.g., "github indexer", "workflow", "CI")
- Include closed/completed issues in search results
- Check the "Skillsmith" project backlog
- Look for related epics that might contain the work

### 2. Search the Codebase

Verify the feature doesn't already exist:

```bash
# Search for existing implementations
grep -r "feature_keyword" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/

# Search in specific areas
grep -r "indexer" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.github/
grep -r "workflow" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/core/src/

# Check infrastructure directories
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.github/workflows/
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/supabase/functions/
```

### 3. Review Recent Commits

Check if the work was recently completed:

```bash
# Recent commits with keyword
git log --oneline --since="4 weeks ago" | grep -i "keyword"

# Recent commits in specific path
git log --oneline --since="4 weeks ago" -- .github/workflows/

# View full commit messages for context
git log --since="2 weeks ago" --grep="indexer" --format="%h %s%n%b"
```

### 4. Check GitHub Actions/Workflows

For CI/CD related issues:

```bash
# List all workflows
ls /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.github/workflows/

# Search workflow contents
grep -l "indexer\|publish\|test" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.github/workflows/*.yml
```

---

## Pre-Creation Checklist

Include this checklist in your issue creation process:

```markdown
## Pre-Creation Checklist

- [ ] Searched Linear for similar issues (including closed)
- [ ] Searched codebase with `grep -r "feature_name" packages/`
- [ ] Checked `.github/workflows/` for existing automation
- [ ] Checked `supabase/functions/` for existing edge functions
- [ ] Reviewed commits from past 4 weeks
- [ ] Verified no duplicate in current sprint/cycle
```

---

## Issue Template Additions

When creating issues, include an "Existing Implementation Check" section:

```markdown
## Implementation Status

**Codebase search performed**: Yes/No
**Related existing code**: None found / [path if found]
**Related closed issues**: None / [issue IDs if found]
**Related workflows**: None / [workflow names if found]
```

---

## Weekly Hygiene Tasks

Perform these tasks weekly (suggested: Monday mornings):

### 1. Review Backlog for Stale Issues

```bash
# Check issues not updated in 2+ weeks
# Use Linear filters: Updated < 2 weeks ago, Status = Backlog
```

Questions to ask:
- Is this issue still relevant?
- Has the work been done but issue not closed?
- Should this be deprioritized or cancelled?

### 2. Check for Potential Duplicates

Search patterns to identify duplicates:
- Similar titles with different wording
- Issues in different cycles covering same scope
- Feature requests that overlap with completed work

### 3. Verify Issues Match Repository State

For each in-progress or todo issue:

```bash
# Verify the feature doesn't already exist
grep -r "issue_subject" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/

# Check if related files exist
find /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith -name "*feature*" -type f
```

### 4. Close Issues for Completed Work

When work is discovered to be complete:

```bash
# Mark as done with comment
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-XXXX

# Or update status with verification note
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts status Done XXXX
```

Always add a closing comment explaining:
- Where the implementation exists
- When it was completed (if known)
- Any relevant commit hashes

---

## Quick Reference Commands

### Linear Operations

```bash
# Check Linear connection
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts whoami

# Mark issues as done
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-1185 SMI-1186

# Mark issues as in progress
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts wip SMI-1187

# Update to any status
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts status Done 1185 1186
```

### Codebase Search

```bash
# Search all packages
grep -r "search_term" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/packages/

# Search with file type filter
grep -r "search_term" --include="*.ts" /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/

# Find files by name pattern
find /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith -name "*pattern*" -type f

# List directory contents
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.github/workflows/
```

### Git History

```bash
# Recent commits
git log --oneline -20

# Commits with keyword
git log --oneline --since="4 weeks ago" | grep -i "keyword"

# Commits in specific path
git log --oneline -- path/to/directory/

# Show files changed in recent commits
git log --oneline --name-only -10
```

---

## Common Duplicate Patterns

Watch for these common duplicate scenarios:

| Scenario | How to Detect |
|----------|---------------|
| CI/CD workflow issues | Check `.github/workflows/` directory |
| API endpoint issues | Search `packages/mcp-server/src/tools/` |
| Database/migration issues | Check `supabase/migrations/` |
| Documentation issues | Search `docs/` directory |
| Configuration issues | Check root config files and `packages/*/package.json` |

---

## Escalation

If you discover a significant backlog quality issue:

1. Document the issue in `docs/retros/` with findings
2. Create a cleanup issue if multiple duplicates found
3. Consider whether process changes are needed
4. Update this guide with new patterns discovered

---

## Commit Message Patterns for Auto-Closing Issues

Linear's GitHub integration automatically closes issues when commits with specific patterns are merged to the default branch.

### Auto-Close Syntax

```bash
# Single issue - auto-closes SMI-1234 when merged
git commit -m "feat(auth): implement SSO flow

Resolves: SMI-1234"

# Multiple issues - auto-closes all listed issues
git commit -m "fix(enterprise): add individual tier support

Fixes TypeScript build errors by completing tier implementation.

Resolves: SMI-1372, SMI-1373, SMI-1374"
```

### Supported Keywords

All of these keywords trigger auto-close:

| Keyword | Example |
|---------|---------|
| `Resolves:` | `Resolves: SMI-1234` |
| `Fixes:` | `Fixes: SMI-1234` |
| `Closes:` | `Closes: SMI-1234` |

### Best Practices

1. **Use `Resolves:` for feature completions** - Indicates issue is fully addressed
2. **Use `Fixes:` for bug fixes** - Semantically clearer for defects
3. **Include in commit body, not title** - Keeps title concise
4. **Verify after push** - Check Linear to confirm auto-transition worked

> **Note**: Auto-close only triggers on the default branch (usually `main`). Commits to feature branches won't close issues until merged.

---

## Related Documentation

- [Engineering Standards](/docs/architecture/standards.md)
- [Linear Skill Documentation](~/.claude/skills/linear/skills/linear/SKILL.md)
- [Governance Skill](/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.claude/skills/governance/SKILL.md)
