# Git-Crypt Integration

Handling encrypted files in worktrees.

---

## Key Insight: How Git-Crypt Works with Worktrees

**Git worktrees share the `.git` directory with the main repo**, but each worktree has its own gitdir location. Git-crypt keys are stored in `.git/git-crypt/keys/`, and worktrees need access to these keys.

When you create a worktree:
- The worktree directory contains a `.git` **file** (not directory) pointing to the actual gitdir
- The gitdir is typically at `.git/worktrees/<name>/`
- Git-crypt looks for keys in the gitdir, not the main `.git` directory

This is why simple `git-crypt unlock` in the main repo may not always work for worktrees.

---

## Recommended: 4-Step Worktree Creation for Encrypted Repos

For repos with git-crypt encrypted files, use this process to ensure decryption works:

```bash
# Step 1: Create worktree WITHOUT checkout (avoids encrypted file issues)
git worktree add --no-checkout ../worktrees/my-feature -b feature/my-feature

# Step 2: Find the worktree's gitdir location
WORKTREE_GITDIR=$(cat ../worktrees/my-feature/.git)

# Step 3: Copy git-crypt keys from main repo to worktree's gitdir
cp -r .git/git-crypt "${WORKTREE_GITDIR#gitdir: }/git-crypt"

# Step 4: Now checkout files (they will be decrypted properly)
cd ../worktrees/my-feature && git reset --hard
```

**Why this works:**
- `--no-checkout` prevents git from checking out encrypted files before keys are available
- Copying the keys ensures the worktree's gitdir has access to decryption
- `git reset --hard` triggers the smudge filter with keys in place

---

## Alternative: Unlock Main Repo First (Simple Case)

For fresh worktrees from an already-unlocked main repo, this simpler approach often works:

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

**Note**: If files still appear encrypted after this approach, use the 4-step process above or the helper script.

---

## Helper Script: worktree-crypt.sh

The project includes a helper script at `scripts/worktree-crypt.sh` that automates the 4-step process:

```bash
# Create a new encrypted-repo-aware worktree
./scripts/worktree-crypt.sh create my-feature feature/my-feature

# Fix an existing worktree with encryption issues
./scripts/worktree-crypt.sh fix ../worktrees/my-feature

# Check encryption status
./scripts/worktree-crypt.sh status ../worktrees/my-feature
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

### Issue: Files still show encrypted content in worktree

**Cause**: Git smudge filter not triggered, or keys not in worktree's gitdir
**Solution** (in order of preference):

```bash
# Option 1: Use the helper script
./scripts/worktree-crypt.sh fix ../worktrees/my-feature

# Option 2: Copy keys manually and re-checkout
WORKTREE_GITDIR=$(cat ../worktrees/my-feature/.git)
cp -r .git/git-crypt "${WORKTREE_GITDIR#gitdir: }/git-crypt"
cd ../worktrees/my-feature && git checkout -- docs/

# Option 3: Manually apply smudge filter
cd ../worktrees/my-feature
for f in docs/**/*.md; do
  if [ -f "$f" ]; then
    cat "$f" | git-crypt smudge > "/tmp/$(basename $f)" 2>/dev/null
    mv "/tmp/$(basename $f)" "$f"
  fi
done
```

### Issue: git-crypt unlock fails in worktree

**Cause**: Keys may already be present in the worktree's gitdir
**Solution**:

```bash
# Check if keys exist
WORKTREE_GITDIR=$(cat ../worktrees/my-feature/.git)
ls -la "${WORKTREE_GITDIR#gitdir: }/git-crypt" 2>/dev/null

# If keys exist, just checkout the files
cd ../worktrees/my-feature
git checkout -- docs/

# Or force reset
git reset --hard HEAD
```

### Issue: "git-crypt: this repository has already been unlocked"

**Cause**: Git-crypt was previously unlocked
**Solution**: This is fine. If files are still encrypted, the issue is the smudge filter. Run:

```bash
git checkout -- docs/
# Or use the helper script
./scripts/worktree-crypt.sh fix ../worktrees/my-feature
```

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

### Issue: New worktree created but all files show as binary

**Cause**: Worktree was created with checkout before keys were available
**Solution**: Use the 4-step creation process for future worktrees. For existing:

```bash
# Fix existing worktree
cd /path/to/main/repo
./scripts/worktree-crypt.sh fix ../worktrees/my-feature
```
