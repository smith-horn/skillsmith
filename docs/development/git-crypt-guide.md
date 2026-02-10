# Git-Crypt Guide

Complete reference for git-crypt encrypted documentation, worktree setup, and common workarounds.

## Encrypted Paths

| Path | Contains |
|------|----------|
| `docs/**` | ADRs, implementation plans, architecture docs |
| `.claude/**` | Agent definitions, skills, hive mind configs |
| `supabase/**` | Edge functions, migrations |

**Exceptions** (unencrypted):

| Path | Why |
|------|-----|
| `docs/development/*.md` | Developer guides must be readable without unlock |
| `docs/templates/*.md` | Templates must be readable without unlock |
| `supabase/rollbacks/**` | Emergency rollback scripts |

## Setup

Set `GIT_CRYPT_KEY_PATH` in your `.env` file (see `.env.example`). Key path is managed via Varlock.

## Check Status

```bash
git-crypt status docs/ | head -5
# If you see "encrypted:" prefix, files are locked
```

## Unlock

```bash
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
```

## Files Still Encrypted After Unlock

If `git-crypt unlock` succeeds but files still show encrypted content, the smudge filter isn't being triggered:

```bash
for f in docs/gtm/*.md docs/gtm/**/*.md; do
  if [ -f "$f" ]; then
    cat "$f" | git-crypt smudge > "/tmp/$(basename $f)" 2>/dev/null
    mv "/tmp/$(basename $f)" "$f"
  fi
done
```

## Rebasing with Git-Crypt

`git pull --rebase` fails in git-crypt repos because the smudge filter creates persistent dirty files that block rebasing. Use `format-patch` to preserve local commits:

```bash
# 1. Save local commits as patches
git format-patch -N HEAD -o /tmp/patches/   # N = number of unpushed commits

# 2. Reset to remote
git fetch origin main
git reset --hard origin/main

# 3. Re-apply patches
git am /tmp/patches/*.patch

# 4. If a patch conflicts, abort and apply manually
git am --abort
# Then apply changes by hand (e.g., sed for bulk replacements)
```

**When to use**: Any time `git pull --rebase` fails with "You have unstaged changes" due to git-crypt smudge filter artifacts.

## Worktree Setup

### Automated (Recommended)

```bash
./scripts/create-worktree.sh worktrees/my-feature feature/my-feature
./scripts/create-worktree.sh --help
```

The script handles:

1. Validates git-crypt is unlocked in main repo
2. Creates worktree with `--no-checkout` to avoid smudge filter errors
3. Copies git-crypt keys to worktree's gitdir
4. Checks out files with decryption working

### Manual Method

```bash
# Step 1: Create without checkout
git worktree add --no-checkout worktrees/<name> -b <branch> main

# Step 2: Find worktree's gitdir
GIT_DIR=$(cat worktrees/<name>/.git | sed 's/gitdir: //')

# Step 3: Copy git-crypt keys
mkdir -p "$GIT_DIR/git-crypt/keys"
cp -r .git/git-crypt/keys/* "$GIT_DIR/git-crypt/keys/"

# Step 4: Checkout files
cd worktrees/<name> && git reset --hard HEAD
```

### Removing Worktrees

```bash
./scripts/remove-worktree.sh --prune
```

Includes Docker network cleanup. Use `--force` flag if smudge artifacts block removal.

### Important

Git-crypt must be unlocked in the **main repo first** before creating worktrees:

```bash
cd /path/to/skillsmith
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
git worktree add ../worktrees/my-feature -b feature/my-feature
```
