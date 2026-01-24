# Git-Crypt Integration

Handling encrypted files in worktrees.

---

## Key Principle: Unlock Main Repo First

**Git-crypt state is inherited by worktrees.** You must unlock in the main repository BEFORE creating worktrees:

```bash
# 1. Unlock in main repo FIRST
cd /path/to/main/repo
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'

# 2. Verify unlocked (should show plaintext, not binary)
head -5 docs/architecture/standards.md

# 3. THEN create worktree
git worktree add ../worktrees/my-feature -b feature/my-feature

# 4. Worktree inherits unlocked state automatically
cd ../worktrees/my-feature
head -5 docs/architecture/standards.md  # Should also be plaintext
```

---

## Checking Git-Crypt Status

```bash
# In main repo or any worktree:
git-crypt status docs/ | head -5

# If you see "encrypted:" prefix, files are locked
# If you see "not encrypted:", files are readable
```

---

## Common Patterns

### Pattern 1: Encrypted Docs Not Readable in Worktree

**Symptom**: Files in `docs/` or `.claude/hive-mind/` show binary content
**Cause**: Main repo was not unlocked before worktree creation
**Solution**:

```bash
# Go to main repo
cd /path/to/main/repo

# Unlock
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'

# The worktree should now see decrypted files
cd ../worktrees/my-feature
cat docs/architecture/standards.md  # Now readable
```

### Pattern 2: CI Linting Fails on Encrypted Files

**Symptom**: ESLint or Prettier fails in CI on encrypted TypeScript/Markdown files
**Cause**: CI doesn't have git-crypt key, so files remain binary
**Solution**:
1. Add encrypted directories to `.prettierignore`
2. Add encrypted patterns to ESLint ignores in `eslint.config.js`

```bash
# .prettierignore
docs/
.claude/hive-mind/

# eslint.config.js (flat config)
const globalIgnores = {
  ignores: [
    'docs/**/*.ts',
    // ... other patterns
  ],
}
```

### Pattern 3: Files Show Encrypted After .gitattributes Change

**Symptom**: Changed `.gitattributes` to exclude files from encryption, but they still show as binary
**Cause**: Changing patterns doesn't auto-decrypt existing files
**Solution**:

```bash
# Force git to re-apply filters
git rm --cached <file>
git add <file>

# Or for directories:
git rm -r --cached docs/templates/
git add docs/templates/

# Verify
git-crypt status docs/templates/
```

---

## Docker Volume Mounts

**Important**: Docker containers mount from specific paths. Ensure your Docker setup mounts from the worktree, not just the main repo:

```bash
# Check what's actually mounted
docker inspect skillsmith-dev-1 | grep -A5 '"Mounts"'

# If pointing to main repo path, changes in worktree won't be visible
# Solution: Restart Docker from within the worktree directory:
cd ../worktrees/my-feature
docker compose --profile dev down
docker compose --profile dev up -d
```

---

## Worktree Launch Script with Git-Crypt

Add this to your worktree launch script:

```bash
#!/bin/bash
set -e

MAIN_REPO="/path/to/main/repo"
WORKTREE_PATH="../worktrees/$1"

# Ensure git-crypt is unlocked in main repo
if git-crypt status docs/ 2>/dev/null | grep -q "encrypted:"; then
  echo "Unlocking git-crypt in main repo..."
  cd "$MAIN_REPO"
  varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
fi

# Now create/navigate to worktree
cd "$WORKTREE_PATH" 2>/dev/null || {
  cd "$MAIN_REPO"
  git worktree add "$WORKTREE_PATH" -b "$2"
  cd "$WORKTREE_PATH"
}

# Verify encrypted files are readable
if head -1 docs/architecture/standards.md 2>/dev/null | grep -q "^#"; then
  echo "Git-crypt: Unlocked (docs readable)"
else
  echo "WARNING: Encrypted files may not be readable"
fi
```

---

## Encrypted Paths Reference

| Path | Contains | Notes |
|------|----------|-------|
| `docs/**` | ADRs, implementation plans, architecture docs | Encrypted |
| `.claude/hive-mind/**` | Hive mind execution configs | Encrypted |
| `docs/development/*.md` | Development guides | NOT encrypted |
| `docs/templates/*.md` | Document templates | NOT encrypted |

---

## Troubleshooting Git-Crypt

### Issue: Git-crypt unlock succeeds but files still encrypted

**Cause**: Git smudge filter not triggered for existing files
**Solution**:

```bash
# Force re-checkout of encrypted files
git checkout -- docs/

# Or manually apply smudge filter
for f in docs/**/*.md; do
  cat "$f" | git-crypt smudge > "/tmp/$(basename $f)"
  mv "/tmp/$(basename $f)" "$f"
done
```

### Issue: "git-crypt: this repository has already been unlocked"

**Cause**: Git-crypt was previously unlocked
**Solution**: This is fine, proceed with worktree creation

### Issue: "fatal: not a git-crypt encrypted repository"

**Cause**: Repository doesn't use git-crypt or you're in wrong directory
**Solution**:
1. Check if `.gitattributes` contains git-crypt patterns
2. Ensure you're in the correct repository

### Issue: Key not found at path

**Cause**: `GIT_CRYPT_KEY_PATH` not set or path incorrect
**Solution**:
1. Check `.env` file has `GIT_CRYPT_KEY_PATH` set
2. Verify the key file exists at that path
3. Use `varlock load` to validate environment
