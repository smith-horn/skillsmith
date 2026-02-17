# Git-Crypt Guide

Complete reference for git-crypt encrypted documentation, worktree setup, and common workarounds.

## Encrypted Paths (Narrowed Scope — SMI-2604)

After the git-crypt remediation, encryption is limited to secrets and sensitive code:

| Path | Contains |
|------|----------|
| `.claude/skills/**` | Agent skill definitions |
| `.claude/plans/**` | Implementation plans |
| `.claude/hive-mind/**` | Hive mind configs |
| `supabase/functions/**` | Edge functions |
| `supabase/migrations/**` | Database migrations |

**Explicitly excluded** from encryption:

| Path | Why |
|------|-----|
| `.claude/settings.json` | Must be readable for Claude Code config |
| `supabase/config.toml` | Needed for CI without git-crypt |
| `supabase/rollbacks/**` | Emergency rollback scripts |

**Not encrypted** (always readable): `docs/development/`, `docs/templates/`, `docs/implementation/`. Internal docs (ADRs, architecture, process) are in a private submodule at `docs/internal/`.

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

If `git-crypt unlock` succeeds but files still show encrypted content, the smudge filter isn't being triggered. Re-run the filter manually on the remaining encrypted paths:

```bash
# Check which files are still encrypted
git-crypt status | grep "encrypted:" | head -10

# Force re-apply smudge filter on a specific file
git checkout -- path/to/encrypted/file
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

## Submodule Workflow

Internal docs are in a private submodule. After cloning or creating a worktree:

```bash
git submodule update --init          # Init submodule (requires org access)
ls docs/internal/adr/                # Verify ADRs are available
```

The `--recurse-submodules` flag is optional for `git clone`. External contributors can work without the submodule.

## History Cleanup

The git history contains encrypted blobs from the pre-migration era. These are harmless — they are unreadable without the git-crypt key and pose no security risk. History rewriting (`git filter-repo`) was considered and rejected because it would rewrite all commit hashes, breaking PR references and contributor attribution. If repo size becomes a concern, this can be revisited as a separate initiative.
