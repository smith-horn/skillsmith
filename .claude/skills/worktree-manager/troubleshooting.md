# Worktree Manager Troubleshooting

Common issues and their solutions.

---

## Worktree Creation Issues

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

---

## Merge Conflict Issues

### Issue: Massive conflicts in index.ts

**Cause**: Didn't use staggered exports strategy
**Solution**: Use cherry-pick recovery:

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

## Git-Crypt Issues

### Issue: Encrypted files showing binary in worktree

**Cause**: Worktree doesn't have git-crypt keys in its gitdir
**Solution** (recommended 4-step process for new worktrees):

```bash
# Step 1: Create worktree without checkout
git worktree add --no-checkout ../worktrees/my-feature -b feature/my-feature

# Step 2: Find the worktree's gitdir
WORKTREE_GITDIR=$(cat ../worktrees/my-feature/.git)

# Step 3: Copy git-crypt keys from main repo
cp -r .git/git-crypt "${WORKTREE_GITDIR#gitdir: }/git-crypt"

# Step 4: Checkout files (will be decrypted)
cd ../worktrees/my-feature && git reset --hard
```

For existing worktrees, use the helper script:
```bash
./scripts/worktree-crypt.sh fix ../worktrees/my-feature
```

### Issue: Git-crypt unlock succeeds but files still encrypted

**Cause**: Git smudge filter not triggered for existing files
**Solution**:
```bash
# Option 1: Force re-checkout
git checkout -- docs/

# Option 2: Use helper script
./scripts/worktree-crypt.sh fix ../worktrees/my-feature

# Option 3: Manually apply smudge filter
for f in docs/**/*.md; do
  if [ -f "$f" ]; then
    cat "$f" | git-crypt smudge > "/tmp/$(basename $f)" 2>/dev/null
    mv "/tmp/$(basename $f)" "$f"
  fi
done
```

### Issue: git-crypt unlock fails with "already unlocked"

**Cause**: Keys are already present, but smudge filter wasn't triggered
**Solution**: Just checkout the files, no need to unlock again:
```bash
git checkout -- docs/
# Or
git reset --hard HEAD
```

### Issue: ESLint/Prettier failing in CI on encrypted files

**Cause**: CI environment doesn't have git-crypt key, files remain binary
**Solution**:
1. Add encrypted directories to `.prettierignore`
2. Add encrypted patterns to ESLint config ignores

```bash
# .prettierignore
docs/
.claude/hive-mind/
```

---

## Docker Issues

### Issue: "current working directory is outside of container mount namespace root"

**Cause**: Docker exec inherits the host's current directory, which doesn't exist in the container when running from a worktree
**Solution**: Always use `-w /app` flag with docker exec

```bash
# From a worktree directory, this will fail:
docker exec skillsmith-dev-1 npm test  # ERROR

# Use -w /app to specify the container working directory:
docker exec -w /app skillsmith-dev-1 npm test  # WORKS
```

**Note**: As of SMI-1774, the git hooks (pre-push, pre-push-check.sh) have been updated to include `-w /app` automatically.

### Issue: Docker changes not visible in worktree

**Cause**: Docker container mounted from main repo path, not worktree path
**Solution**:
```bash
# Check current mounts
docker inspect skillsmith-dev-1 | grep -A5 '"Source"'

# Restart Docker from worktree directory
cd ../worktrees/my-feature
docker compose --profile dev down
docker compose --profile dev up -d
```

### Issue: Docker lint/typecheck verifies main repo, not worktree

**Cause**: Docker container mounts the main repo at `/app`, so `docker exec skillsmith-dev-1 npm run lint` checks main repo files, not your worktree changes.

**Solution**: Use the worktree-check script for local verification:

```bash
# Run lint/typecheck directly in worktree (no Docker needed)
./scripts/worktree-check.sh ../worktrees/my-feature

# Or from within the worktree
cd ../worktrees/my-feature
../../scripts/worktree-check.sh
```

**Note**: Lint, typecheck, and format checks don't require native modules, so they can run locally without Docker. For tests that need native modules (better-sqlite3, onnxruntime), push the branch and verify in CI.

**What the script runs**:
1. `npx tsc --noEmit` - TypeScript type checking
2. `npx eslint . --max-warnings 0` - Linting
3. `npx prettier --check ...` - Format checking

### Issue: Container won't start in worktree

**Cause**: Port conflicts with main repo container or missing volumes
**Solution**:
```bash
# Stop containers in main repo
cd /path/to/main/repo
docker compose --profile dev down

# Start in worktree
cd ../worktrees/my-feature
docker compose --profile dev up -d
```

---

## Claude Code Issues

### Issue: "requires valid session ID" when launching

**Cause**: Using `claude --resume` with a prompt instead of session ID
**Solution**:

**WRONG**:
```bash
claude --resume "Execute task..."  # --resume expects a UUID!
```

**CORRECT**:
```bash
cat << 'PROMPT'
================================================================================
SMI-XXX: Task Title
================================================================================
[Task details...]
================================================================================
PROMPT

claude
```

### Issue: Claude doesn't see files in worktree

**Cause**: Claude launched from wrong directory
**Solution**:
```bash
# Ensure you're in the worktree
cd ../worktrees/my-feature
pwd  # Verify path

# Then launch Claude
claude
```

---

## Session Coordination Issues

### Issue: Conflicting changes from parallel sessions

**Cause**: Sessions not rebasing before pushing
**Solution**:
```bash
# Always rebase before pushing
git fetch origin main
git rebase origin/main

# Then push
git push origin $(git branch --show-current)
```

### Issue: Session can't push due to diverged history

**Cause**: Another session pushed while you were working
**Solution**:
```bash
# Fetch and rebase
git fetch origin main
git rebase origin/main

# Resolve any conflicts
git add -A
git rebase --continue

# Push with force-with-lease (safer than --force)
git push --force-with-lease origin $(git branch --show-current)
```

---

## Performance Issues

### Issue: System running slow with multiple worktrees

**Cause**: Too many parallel agents consuming resources
**Solution**:
1. Check memory usage: `htop` or Activity Monitor
2. Reduce number of worktrees/agents
3. Use single worktree pattern for sequential work
4. Reference resource guidelines:

| Environment | Max Worktrees | Max Agents |
|-------------|---------------|------------|
| MacBook | 1 | 2-3 |
| Workstation | 1-2 | 4-6 |
| Server | Multiple | 8+ |

### Issue: Disk space low

**Cause**: Many worktrees with large node_modules
**Solution**:
```bash
# Remove completed worktrees
git worktree remove ../worktrees/completed-feature

# Prune stale references
git worktree prune

# Clean Docker if needed
docker system prune -a
```

---

## Quick Diagnostics

### Check Worktree Health

```bash
# List all worktrees and their status
git worktree list

# Check for stale references
git worktree prune --dry-run

# Verify current worktree
echo "Current directory: $(pwd)"
echo "Git root: $(git rev-parse --show-toplevel)"
echo "Current branch: $(git branch --show-current)"
```

### Check Git-Crypt Status

```bash
# Check if files are encrypted
git-crypt status docs/ | head -5

# Check if locked
git-crypt status 2>&1 | grep -q "not a git-crypt" && echo "Not encrypted" || echo "Git-crypt repo"
```

### Check Docker Health

```bash
# List containers
docker ps --filter name=skillsmith

# Check container health
docker inspect skillsmith-dev-1 --format='{{.State.Health.Status}}'

# Check mounts
docker inspect skillsmith-dev-1 | grep -A5 '"Source"'
```
