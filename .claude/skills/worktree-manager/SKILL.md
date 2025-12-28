---
name: "Worktree Manager"
description: "Manage git worktrees for parallel development with conflict prevention. Use when creating feature branches, starting parallel work sessions, merging worktree PRs, or coordinating multiple Claude sessions. Prevents index.ts export conflicts through staggered exports strategy."
---

# Worktree Manager

> **Attribution**: This skill is inspired by [@obra's using-git-worktrees skill](https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/SKILL.md) from the Superpowers repository and the [git worktree pattern](https://github.com/anthropics/claude-code/issues/1052) documented in claude-code issues.

## What This Skill Does

Creates and manages isolated git worktrees for parallel feature development while **preventing merge conflicts** in shared files like `packages/core/src/index.ts`.

**Key Features**:
1. Smart worktree creation with pre-configured export stubs
2. Rebase-first workflow to prevent conflict cascades
3. Shared file registry for conflict detection
4. Coordination protocol for multi-session development

## Prerequisites

- Git 2.20+ (for worktree support)
- This repository cloned locally
- Understanding of the monorepo structure

## Quick Start

### Creating a New Worktree

```bash
# 1. Ensure you're on main and up-to-date
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
git checkout main && git pull origin main

# 2. Create worktree directory (if not exists)
mkdir -p ../worktrees

# 3. Create worktree for your feature
git worktree add ../worktrees/feature-name -b feature/feature-name

# 4. Navigate to worktree
cd ../worktrees/feature-name
```

### Before Starting Work

**CRITICAL**: Check the shared files registry before modifying:

```bash
# Files that commonly cause merge conflicts:
cat << 'EOF'
SHARED FILES - Coordinate before modifying:
- packages/core/src/index.ts (exports)
- packages/core/package.json (dependencies)
- packages/mcp-server/src/index.ts (server exports)
- package.json (root dependencies)
- tsconfig.json (compiler options)
EOF
```

---

## Conflict Prevention Strategy

### The Problem We Solve

When multiple worktrees modify `packages/core/src/index.ts` to add exports, sequential merging causes conflict cascades:

```
Worktree A: adds session exports → merged first ✓
Worktree B: adds benchmark exports → CONFLICT (missing session exports)
Worktree C: adds webhook exports → CONFLICT (missing both)
```

### The Solution: Staggered Exports

**BEFORE creating worktrees**, add stub exports to main:

```typescript
// packages/core/src/index.ts - Add stubs FIRST

// Session (SMI-XXX) - to be implemented
// export * from './session/index.js'

// Benchmarks (SMI-XXX) - to be implemented
// export * from './benchmarks/index.js'

// Webhooks (SMI-XXX) - to be implemented
// export * from './webhooks/index.js'
```

Then each worktree only:
1. Creates its own `src/[feature]/` directory
2. Creates its own `src/[feature]/index.ts`
3. Uncomments its single line in the main index.ts

**Result**: No conflicts because each worktree touches a different line!

---

## Step-by-Step Workflow

### Phase 1: Planning (Before Creating Worktrees)

```bash
# 1. List all planned features
echo "Planned features for this phase:"
echo "- Feature A (SMI-XXX)"
echo "- Feature B (SMI-XXX)"
echo "- Feature C (SMI-XXX)"

# 2. Create stub exports in main
git checkout main
# Edit packages/core/src/index.ts to add commented export stubs

# 3. Commit the stubs
git add packages/core/src/index.ts
git commit -m "chore: add export stubs for Phase X features"
git push origin main
```

### Phase 2: Creating Worktrees

```bash
# For each feature:
FEATURE="session"  # Change per feature
ISSUE="SMI-641"    # Change per feature

# Create worktree
git worktree add ../worktrees/phase-2c-$FEATURE -b phase-2c-$FEATURE

# Navigate
cd ../worktrees/phase-2c-$FEATURE

# Verify starting point
git log --oneline -1
```

### Phase 3: Development (In Each Worktree)

```bash
# Start of session - always rebase first
git fetch origin main
git rebase origin/main

# Do your work...
# - Create src/[feature]/ directory
# - Implement feature
# - Write tests
# - Uncomment YOUR export line in index.ts

# End of session - commit
git add -A
git commit -m "feat($FEATURE): implement feature ($ISSUE)"
```

### Phase 4: Merging (Sequential, Rebase-First)

```bash
# After first worktree is ready:

# 1. In main repo, merge first PR
git checkout main
git pull origin main
gh pr merge <PR_NUMBER>

# 2. In ALL other worktrees, rebase immediately
cd ../worktrees/phase-2c-other-feature
git fetch origin main
git rebase origin/main
# Resolve any conflicts NOW while context is fresh

# 3. Repeat for each subsequent PR
```

### Phase 5: Cleanup

```bash
# After all PRs merged:
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Remove worktrees
git worktree remove ../worktrees/phase-2c-session
git worktree remove ../worktrees/phase-2c-perf
git worktree remove ../worktrees/phase-2c-webhooks

# Prune stale worktree references
git worktree prune

# Verify cleanup
git worktree list
```

---

## Worktree Directory Structure

```
/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/
├── skillsmith/                    # Main repository
│   ├── .git/                      # Git directory (shared)
│   ├── packages/
│   └── ...
└── worktrees/                     # Worktree container (gitignored)
    ├── phase-2c-session/          # Feature worktree
    │   ├── packages/
    │   └── ...
    ├── phase-2c-perf/             # Feature worktree
    └── phase-2c-webhooks/         # Feature worktree
```

**Important**: The `worktrees/` directory should be:
- Outside the main repo directory
- Added to global gitignore (`~/.gitignore_global`)

---

## Coordination Protocol

### For Multi-Session Development

When running multiple Claude sessions in different worktrees:

#### Session Start Checklist

```bash
# 1. Announce your worktree
echo "Starting work in worktree: $(git worktree list | grep $(pwd))"

# 2. Check for recent changes to shared files
git fetch origin main
git log origin/main --oneline -5 -- packages/core/src/index.ts

# 3. Rebase if needed
git rebase origin/main
```

#### Before Modifying Shared Files

```bash
# Check if another session recently modified the file
git log origin/main --oneline -3 -- packages/core/src/index.ts

# If changes exist, rebase first
git fetch origin main && git rebase origin/main
```

#### Session End Checklist

```bash
# 1. Commit all changes
git add -A && git status

# 2. Push to remote (for PR)
git push origin $(git branch --show-current)

# 3. Notify other sessions to rebase
echo "Pushed changes. Other worktrees should: git fetch && git rebase origin/main"
```

---

## Handling Merge Conflicts

### If Conflicts Occur During Rebase

```bash
# 1. See which files conflict
git status

# 2. For index.ts conflicts, combine all exports
# Open the file and ensure ALL exports from both versions are present

# 3. Mark resolved
git add packages/core/src/index.ts

# 4. Continue rebase
git rebase --continue
```

### Cherry-Pick Recovery (Last Resort)

If worktree is too far behind and rebasing is painful:

```bash
# 1. Note your unique commits
git log --oneline origin/main..HEAD

# 2. Create clean branch from current main
git checkout main && git pull
git checkout -b phase-2c-feature-clean

# 3. Cherry-pick your commits
git cherry-pick <commit1> <commit2>

# 4. Resolve conflicts during cherry-pick
# Then create new PR from clean branch
```

---

## Scripts

The skill includes helper scripts in `scripts/`:

| Script | Purpose |
|--------|---------|
| `worktree-create.sh` | Create a new worktree with branch |
| `worktree-status.sh` | Show status of all worktrees |
| `worktree-sync.sh` | Sync all worktrees with main |
| `worktree-cleanup.sh` | Clean up merged worktrees |
| `generate-launch-script.sh` | Generate Claude Code launch script |

### Generating Launch Scripts for Parallel Claude Sessions

Use `generate-launch-script.sh` to create terminal scripts that:
1. Navigate to the worktree
2. Sync with origin/main
3. Check Docker container health
4. Display the task prompt
5. Launch Claude Code

```bash
# With prompt file
./scripts/generate-launch-script.sh ../worktrees/smi-619 SMI-619 "CI/CD Docker" prompt.md

# With inline prompt
echo "Configure CI/CD pipeline with Docker" | \
  ./scripts/generate-launch-script.sh ../worktrees/smi-619 SMI-619 "CI/CD Docker"
```

### Key Learning: Claude Code Invocation

**WRONG** (causes "requires valid session ID" error):
```bash
claude --resume "Execute task..."  # --resume expects a UUID, not a prompt!
```

**CORRECT** (display prompt, then launch interactive claude):
```bash
cat << 'PROMPT'
================================================================================
SMI-XXX: Task Title
================================================================================

## IMPORTANT: Use Docker Skill
Run /docker before executing any npm commands.

[Task details...]

## When Done
1. Commit with conventional commit message
2. Push to remote
3. Create PR
================================================================================
PROMPT

claude
```

### Docker Container Health Check

Include this in launch scripts when the project uses Docker:

```bash
# Check if Docker container is running
if ! docker ps --filter name=skillsmith-dev-1 --format "{{.Status}}" | grep -q "Up"; then
  echo "Starting Docker container..."
  docker compose --profile dev up -d
  sleep 3
fi
```

### scripts/worktree-create.sh

```bash
./scripts/worktree-create.sh <feature-name> [issue-id] [base-branch]

# Examples:
./scripts/worktree-create.sh session SMI-641
./scripts/worktree-create.sh webhooks SMI-645 main
./scripts/worktree-create.sh hotfix-auth
```

### scripts/worktree-sync.sh

Syncs all worktrees with origin/main via rebase:

```bash
./scripts/worktree-sync.sh [--dry-run]
```

### scripts/worktree-status.sh

Shows status of all worktrees with behind/ahead counts:

```bash
./scripts/worktree-status.sh [--verbose]
```

### scripts/worktree-cleanup.sh

Removes worktrees that have been merged:

```bash
./scripts/worktree-cleanup.sh [--all] [--force] [worktree-name]
```

---

## Troubleshooting

### Issue: "fatal: 'path' is already checked out"

**Cause**: Trying to create worktree for branch that's already checked out
**Solution**:
```bash
# Check where it's checked out
git worktree list

# Either use that worktree or create new branch
git worktree add ../worktrees/new-name -b new-branch-name
```

### Issue: Cannot delete branch used by worktree

**Cause**: Branch is still associated with a worktree
**Solution**:
```bash
# Remove the worktree first
git worktree remove ../worktrees/feature-name

# Then delete the branch
git branch -d feature-name
```

### Issue: Stale worktree references

**Cause**: Worktree directory was deleted manually
**Solution**:
```bash
git worktree prune
```

### Issue: Massive conflicts in index.ts

**Cause**: Didn't use staggered exports strategy
**Solution**: Use cherry-pick recovery (see above)

---

## Best Practices Summary

1. **Always start from fresh main**: `git checkout main && git pull`
2. **Add export stubs before creating worktrees**
3. **Rebase frequently**: After each merge to main
4. **One feature per worktree**: Keep changes isolated
5. **Merge in order of completion**: Rebase remaining after each merge
6. **Clean up promptly**: Remove worktrees after merge

---

## Related Resources

- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [obra/superpowers](https://github.com/obra/superpowers) - Original inspiration
- [Claude Code Worktree Pattern](https://github.com/anthropics/claude-code/issues/1052)

---

**Created**: December 2025
**Scope**: Internal - Claude-Skill-Discovery repository only
**Maintainer**: Project team
