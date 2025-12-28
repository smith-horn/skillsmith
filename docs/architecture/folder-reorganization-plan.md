# Folder Reorganization Plan

**Issue**: SMI-647 (Epic)
**Status**: ✅ Completed
**Created**: December 28, 2025
**Completed**: December 28, 2025
**Risk Level**: Medium

---

## Objective

Consolidate all Skillsmith-related folders under `/Documents/GitHub/Claude-Skill-Discovery/` for better organization and maintainability.

### Final State (Implemented)
```
/Documents/GitHub/Claude-Skill-Discovery/
├── skillsmith/                   # Main git repo (458M)
│   ├── .git/
│   ├── .claude/                  # Claude Code skills & config
│   │   ├── skills/               # 28 project skills
│   │   ├── commands/             # Slash commands
│   │   └── agents/               # Agent configs
│   ├── packages/
│   │   ├── core/                 # @skillsmith/core
│   │   ├── mcp-server/           # @skillsmith/mcp-server
│   │   └── cli/                  # @skillsmith/cli
│   └── docs/                     # Code documentation
└── worktrees/                    # Git worktrees
    ├── phase-2c-cache/           # SMI-644 Tiered Cache
    ├── phase-2c-perf/            # Performance work
    └── phase-2c-webhooks/        # GitHub webhooks
```

### Changes Made (Option B)
1. ✅ Removed orphan `skillsmith-phase2-indexer` folder
2. ✅ Removed orphan `/GitHub/.claude` folder
3. ✅ Moved `.claude` into git repo at `skillsmith/.claude`
4. ✅ Kept wrapper folder name to preserve worktree absolute paths

---

## Stages

### Stage 0: Pre-Flight Checks
**Risk**: None
**Duration**: 5 minutes

#### Tasks
1. Close all Claude Code sessions working on skillsmith
2. Verify no processes accessing skillsmith folders
3. Create backup of critical state

#### Verification Tests
```bash
# T0.1: No Claude processes on skillsmith
ps aux | grep claude | grep -i skill && echo "FAIL: Close sessions first" || echo "PASS"

# T0.2: No file locks
lsof +D /Users/williamsmith/Documents/GitHub/skillsmith 2>/dev/null | head -5
# Should return empty or minimal results

# T0.3: Git status clean on main repo
cd /Users/williamsmith/Documents/GitHub/skillsmith && git status --porcelain
# Should be empty (all committed)
```

#### Definition of Done
- [ ] All Claude sessions closed
- [ ] No file locks on skillsmith folders
- [ ] All changes committed to git
- [ ] Backup created at `/tmp/skillsmith-backup-$(date +%Y%m%d)`

---

### Stage 1: Cleanup Broken Worktrees
**Risk**: Low
**Duration**: 5 minutes
**Rollback**: Not needed (only removing broken references)

#### Tasks
1. Remove broken skillsmith-phase1 worktree reference
2. Prune all stale worktree entries
3. Verify active worktrees still work

#### Verification Tests
```bash
# T1.1: List worktrees before cleanup
cd /Users/williamsmith/Documents/GitHub/skillsmith
git worktree list > /tmp/worktrees-before.txt
cat /tmp/worktrees-before.txt

# T1.2: Prune and remove broken
git worktree remove ../skillsmith-phase1 --force 2>/dev/null || true
git worktree prune -v

# T1.3: Verify remaining worktrees accessible
git worktree list | while read path branch; do
  if [ -d "$path" ]; then
    echo "✅ $path exists"
  else
    echo "❌ $path MISSING"
  fi
done

# T1.4: Test active worktree still works
cd /Users/williamsmith/Documents/GitHub/skillsmith-phase2-indexer
git status && echo "PASS: Worktree functional" || echo "FAIL"
```

#### Definition of Done
- [ ] skillsmith-phase1 reference removed
- [ ] `git worktree prune` runs without errors
- [ ] Active worktrees (phase2-indexer, phase2b, phase2b-parallel) still functional
- [ ] `git worktree list` shows only valid entries

---

### Stage 2: Consolidate Stale Worktrees
**Risk**: Low
**Duration**: 10 minutes
**Rollback**: Re-add worktrees from branches

#### Tasks
1. Identify stale worktrees (phase2-caching, phase2-testing)
2. Verify no uncommitted changes
3. Remove stale worktrees
4. Delete stale folders

#### Verification Tests
```bash
# T2.1: Check for uncommitted changes in stale worktrees
for wt in skillsmith-phase2-caching skillsmith-phase2-testing; do
  cd /Users/williamsmith/Documents/GitHub/$wt 2>/dev/null || continue
  changes=$(git status --porcelain | wc -l)
  if [ "$changes" -gt 0 ]; then
    echo "⚠️ $wt has uncommitted changes"
    git status --short
  else
    echo "✅ $wt is clean"
  fi
done

# T2.2: Remove stale worktrees
cd /Users/williamsmith/Documents/GitHub/skillsmith
git worktree remove ../skillsmith-phase2-caching --force
git worktree remove ../skillsmith-phase2-testing --force

# T2.3: Verify removal
ls -d /Users/williamsmith/Documents/GitHub/skillsmith-phase2-caching 2>/dev/null && echo "FAIL" || echo "PASS: Removed"
ls -d /Users/williamsmith/Documents/GitHub/skillsmith-phase2-testing 2>/dev/null && echo "FAIL" || echo "PASS: Removed"

# T2.4: Worktree list updated
git worktree list
```

#### Definition of Done
- [ ] No uncommitted changes lost
- [ ] skillsmith-phase2-caching removed
- [ ] skillsmith-phase2-testing removed
- [ ] `git worktree list` shows 5 remaining entries

---

### Stage 3: Move Main Repository
**Risk**: Medium
**Duration**: 15 minutes
**Rollback**: Move folder back to original location

#### Tasks
1. Create target directory structure
2. Move main skillsmith repo
3. Update worktree paths
4. Verify git operations work

#### Verification Tests
```bash
# T3.1: Create target structure
mkdir -p /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees

# T3.2: Move main repo
mv /Users/williamsmith/Documents/GitHub/skillsmith \
   /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/

# T3.3: Verify move succeeded
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/.git && echo "PASS" || echo "FAIL"

# T3.4: Git operations work
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
git status && echo "PASS: Git works" || echo "FAIL"
git log --oneline -3
git remote -v

# T3.5: Branches preserved
git branch -a | head -10
```

#### Rollback Procedure
```bash
# If anything fails, move back:
mv /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith \
   /Users/williamsmith/Documents/GitHub/
```

#### Definition of Done
- [ ] skillsmith folder moved to Claude-Skill-Discovery/
- [ ] `git status` works in new location
- [ ] `git log` shows correct history
- [ ] `git remote -v` shows correct remote
- [ ] All branches accessible

---

### Stage 4: Recreate Active Worktrees
**Risk**: Medium
**Duration**: 20 minutes
**Rollback**: Restore from backup

#### Tasks
1. Remove old worktree registrations
2. Preserve uncommitted changes from active worktrees
3. Create new worktrees in consolidated location
4. Restore any uncommitted changes

#### Pre-Stage: Backup Active Work
```bash
# Backup any uncommitted changes
for wt in skillsmith-phase2-indexer skillsmith-phase2-core skillsmith-phase2b skillsmith-phase2b-parallel; do
  cd /Users/williamsmith/Documents/GitHub/$wt 2>/dev/null || continue
  if [ -n "$(git status --porcelain)" ]; then
    git stash push -m "Pre-move backup $(date +%Y%m%d-%H%M)"
    echo "Stashed changes in $wt"
  fi
done
```

#### Verification Tests
```bash
# T4.1: Prune old worktree references
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
git worktree prune -v

# T4.2: Create new worktrees
WORKTREE_BASE="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees"
git worktree add "$WORKTREE_BASE/phase-2-indexer" phase-2/indexer
git worktree add "$WORKTREE_BASE/phase-2b" phase-2b
git worktree add "$WORKTREE_BASE/phase-2b-parallel" phase-2b-parallel
git worktree add "$WORKTREE_BASE/phase-2-core" phase-2/core

# T4.3: Verify new worktrees
git worktree list

# T4.4: Test each worktree
for wt in phase-2-indexer phase-2b phase-2b-parallel phase-2-core; do
  cd "$WORKTREE_BASE/$wt" && git status && echo "✅ $wt" || echo "❌ $wt"
done

# T4.5: Run typecheck in main worktree
cd "$WORKTREE_BASE/phase-2-indexer/packages/core"
npx tsc --noEmit && echo "PASS: Typecheck" || echo "FAIL"

# T4.6: Run tests
npm test && echo "PASS: Tests" || echo "FAIL"
```

#### Definition of Done
- [ ] All active worktrees recreated in new location
- [ ] `git worktree list` shows correct paths
- [ ] Each worktree passes `git status`
- [ ] Typecheck passes in phase-2-indexer
- [ ] Tests pass in phase-2-indexer
- [ ] Any stashed changes restored

---

### Stage 5: Cleanup Old Folders
**Risk**: Low (after verification)
**Duration**: 5 minutes
**Rollback**: Restore from Trash

#### Tasks
1. Final verification of new structure
2. Move old folders to Trash (not rm -rf)
3. Update documentation

#### Verification Tests
```bash
# T5.1: Final structure verification
echo "=== New Structure ==="
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith/
ls -la /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/

# T5.2: Git fully functional
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith
git fetch origin
git log --oneline -5
git worktree list

# T5.3: Move old folders to Trash (recoverable)
for old in skillsmith-phase2-indexer skillsmith-phase2-core skillsmith-phase2b skillsmith-phase2b-parallel skillsmith-phase1; do
  if [ -d "/Users/williamsmith/Documents/GitHub/$old" ]; then
    mv "/Users/williamsmith/Documents/GitHub/$old" ~/.Trash/
    echo "Moved $old to Trash"
  fi
done

# T5.4: Verify old folders gone
ls /Users/williamsmith/Documents/GitHub/ | grep skillsmith
# Should only show nothing (all moved)

# T5.5: Final count
echo "Folders in GitHub directory:"
ls /Users/williamsmith/Documents/GitHub/ | wc -l
```

#### Definition of Done
- [ ] New structure verified and functional
- [ ] Old folders moved to Trash (not deleted)
- [ ] No skillsmith-* folders in /Documents/GitHub/
- [ ] Claude-Skill-Discovery contains all project files

---

### Stage 6: Update References
**Risk**: Low
**Duration**: 15 minutes

#### Tasks
1. Update launch scripts with new paths
2. Update CLAUDE.md with new paths
3. Fix tsconfig.json rootDir issue
4. Update Linear with new documentation

#### Verification Tests
```bash
# T6.1: Update launch scripts
SKILL_ROOT="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery"
sed -i '' "s|/Documents/GitHub/skillsmith-phase2-indexer|$SKILL_ROOT/skillsmith|g" \
  "$SKILL_ROOT/skillsmith/scripts/launch-*.sh"
sed -i '' "s|/Documents/GitHub/skillsmith-phase2b|$SKILL_ROOT/worktrees/phase-2b|g" \
  "$SKILL_ROOT/skillsmith/scripts/launch-*.sh"

# T6.2: Test launch script still works
cat "$SKILL_ROOT/skillsmith/scripts/launch-smi627.sh" | grep "REPO_DIR="

# T6.3: Fix tsconfig.json
cd "$SKILL_ROOT/skillsmith"
# Update root tsconfig to be monorepo coordinator
# (separate task)

# T6.4: Verify paths in CLAUDE.md
grep -r "skillsmith-phase2" "$SKILL_ROOT/skillsmith/CLAUDE.md" || echo "PASS: No old paths"
```

#### Definition of Done
- [ ] All scripts updated with new paths
- [ ] CLAUDE.md updated
- [ ] tsconfig.json fixed for monorepo
- [ ] Launch scripts tested and working

---

## Summary

| Stage | Risk | Duration | Rollback |
|-------|------|----------|----------|
| 0: Pre-Flight | None | 5 min | N/A |
| 1: Cleanup Broken | Low | 5 min | N/A |
| 2: Remove Stale | Low | 10 min | Re-add worktrees |
| 3: Move Main Repo | Medium | 15 min | Move back |
| 4: Recreate Worktrees | Medium | 20 min | Restore backup |
| 5: Cleanup Old | Low | 5 min | Restore from Trash |
| 6: Update References | Low | 15 min | Git revert |

**Total Duration**: ~75 minutes
**Total Risk**: Medium (with proper verification)

---

## Rollback Master Plan

If anything goes catastrophically wrong:

```bash
# 1. Restore main repo
mv /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith \
   /Users/williamsmith/Documents/GitHub/

# 2. Restore worktrees from Trash
mv ~/.Trash/skillsmith-phase2-* /Users/williamsmith/Documents/GitHub/

# 3. Re-register worktrees
cd /Users/williamsmith/Documents/GitHub/skillsmith
git worktree prune
# Worktrees will auto-reconnect if folders exist
```

---

## Post-Migration Checklist

- [ ] All tests pass
- [ ] Git operations work (push, pull, branch)
- [ ] Worktrees functional
- [ ] Launch scripts work
- [ ] Linear updated
- [ ] Team notified of new paths
