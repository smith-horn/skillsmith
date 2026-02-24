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

**Not encrypted** (always readable): `.claude/development/`, `.claude/templates/`, `docs/implementation/`. Internal docs (ADRs, architecture, process) are in a private submodule at `docs/internal/`.

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

`git pull --rebase` fails in git-crypt repos because the smudge filter creates persistent dirty files that block rebasing.

### Standard rebase (branch behind main, no squash-merge involved)

Use `format-patch` to preserve local commits:

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

**When to use**: Any time `git pull --rebase` fails with "You have unstaged changes" due to git-crypt smudge filter artifacts, **and** no sibling squash-merge has occurred.

### Post-squash wave rebase (SMI-2751)

When a Wave N PR is squash-merged to main and Wave N+1 needs rebasing, **`git format-patch`/`git am` will fail** — the squash commit rewrites the encrypted file blob with a new git-crypt nonce, so the patch content no longer matches the index. **`git cherry-pick` will also fail** because the smudge filter leaves encrypted files permanently dirty.

**Working approach**: recover the Wave N+1 files directly from the reflog commit.

```bash
# 1. Find the Wave N+1 commit(s) in the reflog before the reset
git reflog | head -20
# Look for the commit hash of your wave work (e.g. ed87250b)

# 2. Reset to main
git fetch origin main
git reset --hard origin/main

# 3. Restore only the wave-specific files from the reflog commit
git checkout <sha> -- supabase/functions/some-handler.ts \
                       supabase/functions/_shared/email.ts \
                       supabase/migrations/056_pending_checkouts_trial.sql
# List ALL files changed in Wave N+1 — omit any files that existed unchanged in Wave N

# 4. Stage and commit fresh
git add <wave-files>
git commit -m "feat(scope): Wave N+1 changes"
git push --force-with-lease
```

**Why `git am` fails**: after a squash-merge, GitHub may not apply the git-crypt clean filter, so the encrypted file lands as plaintext in the squash commit on main. The patch blob was encrypted with a different nonce → `does not match index` error.

**Why `cherry-pick` fails**: the smudge filter marks encrypted files as permanently dirty in the working tree after `git reset --hard`. Git refuses to cherry-pick over dirty files.

### Post-squash encryption verification

After any squash-merge of a branch that contains encrypted files, verify the key files landed correctly:

```bash
# Should print "GITCRYPT" (hex: 47 49 54 43 52 59 50 54) — not plaintext TypeScript
git show HEAD:supabase/functions/stripe-webhook/index.ts | xxd | head -1

# If it shows plaintext (e.g., "/**"), the squash bypassed git-crypt.
# Notify the team — the plaintext content is in git history.
```

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
   - 4b. Initializes submodules (`docs/internal`)
   - 4c. Scans `.claude/skills/**` for encrypted files; warns with `varlock run -- git-crypt unlock` command if any remain binary (SMI-2676)
5. Generates Docker override file

**If step 4c warns**: skills like `/launchpad` Stage 4 (`hive-mind-execution`) will silently degrade until git-crypt is unlocked in the worktree. Run the printed unlock command before using `/launchpad`.

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

## Double-Smudge Recovery

When git-crypt's clean filter runs twice on the same content (e.g., after `.gitattributes` scope changes), files become double-encrypted — unreadable even after `git-crypt unlock`. Apply the smudge filter twice to reverse both encryption layers:

```bash
# Recover a single double-encrypted file
git show HEAD:path/to/file | git-crypt smudge | git-crypt smudge > /tmp/recovered-file

# Bulk recover all double-encrypted files in a directory
for file in $(git ls-tree -r --name-only HEAD -- docs/); do
  content=$(git show "HEAD:$file" | git-crypt smudge 2>/dev/null | git-crypt smudge 2>/dev/null)
  if [ -n "$content" ] && ! echo "$content" | head -c 10 | grep -q "GITCRYPT"; then
    mkdir -p "/tmp/recovered/$(dirname "$file")"
    echo "$content" > "/tmp/recovered/$file"
  fi
done
```

**When to use**: After changing `.gitattributes` patterns, if previously-encrypted files appear as binary blobs even with git-crypt unlocked. Discovered during the git-crypt remediation (SMI-2603) where this technique recovered all 331 double-encrypted files with zero data loss.

## History Cleanup

The git history contains encrypted blobs from the pre-migration era. These are harmless — they are unreadable without the git-crypt key and pose no security risk. History rewriting (`git filter-repo`) was considered and rejected because it would rewrite all commit hashes, breaking PR references and contributor attribution. If repo size becomes a concern, this can be revisited as a separate initiative.
