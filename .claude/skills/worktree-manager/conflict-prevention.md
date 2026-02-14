# Conflict Prevention

Strategies for preventing and resolving merge conflicts in worktrees.

---

## The Problem We Solve

When multiple worktrees modify `packages/core/src/index.ts` to add exports, sequential merging causes conflict cascades:

```
Worktree A: adds session exports → merged first ✓
Worktree B: adds benchmark exports → CONFLICT (missing session exports)
Worktree C: adds webhook exports → CONFLICT (missing both)
```

---

## The Solution: Staggered Exports

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

# 4. Create worktree launch scripts (IMPORTANT: Do this during planning!)
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
cd /path/to/main/repo

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

## Worktree Launch Script Template

Include this in your launch scripts:

```bash
#!/bin/bash
set -e

MAIN_REPO="/path/to/main/repo"
WORKTREE_PATH="../worktrees/$1"
BRANCH_NAME="$2"

# Ensure starting from main
cd "$MAIN_REPO"
git checkout main && git pull origin main

# Create or navigate to worktree
if [ ! -d "$WORKTREE_PATH" ]; then
  git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME"
fi

cd "$WORKTREE_PATH"

# Sync with main
git fetch origin main
git rebase origin/main || true

# Docker setup if needed
if command -v docker &> /dev/null && [ -f docker-compose.yml ]; then
    docker compose --profile dev up -d 2>/dev/null || true
fi

echo "Worktree ready: $WORKTREE_PATH"
```

---

## Best Practices Summary

1. **Always start from fresh main**: `git checkout main && git pull`
2. **Add export stubs before creating worktrees**
3. **Rebase frequently**: After each merge to main
4. **One feature per worktree**: Keep changes isolated
5. **Merge in order of completion**: Rebase remaining after each merge
6. **Clean up promptly**: Remove worktrees after merge
