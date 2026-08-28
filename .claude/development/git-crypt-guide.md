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

## Filter Registration Manual Rollback (SMI-5702)

`filter.git-crypt.{smudge,clean,required}` and `diff.git-crypt.textconv` are repo-**shared** state — even `git config --local` from inside a worktree writes to the main checkout's `$GIT_COMMON_DIR/config`, so a broken registration breaks every worktree AND the main checkout at once. Symptom: `fatal: <path>: clean filter 'git-crypt' failed` on worktree creation, `git status`, or `git-crypt unlock` itself hanging/failing with this message.

**Automated fix (always try this first)**:

```bash
./scripts/worktree-crypt.sh fix <worktree-path>
```

This runs `ensure_git_crypt_filter_registered()` (`scripts/_lib.sh`), which classifies the current state (CANONICAL/DISABLED/MISSING/HALF/FOREIGN) and self-heals all four keys, with a post-write read-back verification. Full bypass: `SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE=1`.

**Manual fallback** (only if the automated fix is unavailable) — these are the exact canonical values `ensure_git_crypt_filter_registered()` itself writes, live-verified against `git config --local --get-regexp 'filter\.git-crypt|diff\.git-crypt'`:

```bash
git config --local filter.git-crypt.smudge 'git-crypt smudge'
git config --local filter.git-crypt.clean 'git-crypt clean'
git config --local filter.git-crypt.required true
git config --local diff.git-crypt.textconv '"git-crypt" diff'
```

**Never** remove the `filter.git-crypt.*` config keys directly as a "restore" step (e.g. via `git config --local` with a removal flag) — that is the exact action that broke encryption repo-wide twice, by deleting the shared config outright instead of restoring it (SMI-5702, recurrence SMI-5861). Always set values, never unset them. Full root-cause writeup: [smi-5702-worktree-git-crypt-filter-deadlock.md](../../docs/internal/implementation/smi-5702-worktree-git-crypt-filter-deadlock.md).

## Rebasing with Git-Crypt

`git pull --rebase` fails in git-crypt repos because the smudge filter creates persistent dirty files that block rebasing.

### Automated (Recommended)

For worktree branches, use the rebase script which handles all steps automatically:

```bash
./scripts/rebase-worktree.sh <worktree-path> [target-branch]
# target-branch defaults to origin/main

# Preview steps without executing:
./scripts/rebase-worktree.sh --dry-run <worktree-path>

# Skip submodule steps:
./scripts/rebase-worktree.sh --no-submodule <worktree-path>

# Keep worktree's submodule pointer when it's a strict descendant of target (SMI-4773):
./scripts/rebase-worktree.sh --allow-submodule-ahead <worktree-path>
```

The script handles: submodule cross-fetching, git-crypt filter disable/restore, stash management, submodule conflict auto-resolution, and branch verification. Post-SMI-4829 the script processes all submodules in `.gitmodules` (`docs/internal` + up to 3 strategy mounts: `.claude/skills`, `.claude/plans`, `.claude/hive-mind`). Use `--allow-submodule-ahead=<path>` for per-submodule advance permission when one submodule pointer is a strict descendant of target's (unscoped `--allow-submodule-ahead` applies globally). See `./scripts/rebase-worktree.sh --help` for full details.

**Exit codes**: 0 (success), 1 (validation failure), 2 (rebase conflict -- manual resolution needed), 3 (rebase succeeded but stash pop had conflicts), 4 (SMI-5773: rebase and stash pop both succeeded, but the post-rebase ciphertext scan found encrypted-path files still carrying the `\x00GITCRYPT` header or missing entirely -- the script prints the affected files plus a remediation command).

**When to use manual methods below**: Non-worktree branches, or when the script exits 2 (conflict requires manual resolution with filters already disabled). If the script instead exits 1 with "nothing to resolve" (SMI-5979), filters have already been restored automatically -- just retry the command, no manual steps needed.

**Why exit 4 can happen at all (SMI-5773)**: `git checkout HEAD -- <paths>` skips any file Git already considers stat-clean (size/mtime/ctime/inode match the index) -- it never rewrites it, `force` notwithstanding. During the rebase's filter-disabled window (smudge/clean set to `cat`), any encrypted file the rebase itself rewrites lands on disk as ciphertext but gets recorded stat-clean, so a plain re-checkout after restoring filters silently no-ops on exactly the files that need re-smudging. The fix (`force_resmudge()`) deletes the tracked copies before re-checking them out, forcing an unconditional rewrite through the real smudge filter; `scan_ciphertext()` then verifies no `\x00GITCRYPT`-prefixed or missing file survived. If you're tempted to "fix" a future git-crypt desync by adding another bare `git checkout -- <paths>`, it will not work for this failure class -- delete-then-checkout is required.

**Stash-mtime race mitigation (SMI-5781)**: Step 6 (`step_stash()`) calls `stabilize_encrypted_index_stats()` right after the stash is created. `git stash push` re-checks-out every previously-unstaged path back to HEAD's content, leaving a racy mtime on each restored file; if a stashed path is git-crypt-encrypted, that raciness previously survived into Step 7's filter swap, causing Step 9's rebase pre-flight to re-verify the file's content under the wrong (identity) clean filter and spuriously reject it as dirty -- even though the file is genuinely clean. The mitigation backdates every currently tracked encrypted path's mtime by ~1 hour and refreshes the index (same technique as the SMI-5773 test fixtures' `backdateMtime()`/`backdateTrackedPath()` helpers) before Step 7 ever runs, so the pre-flight check always trusts the cached stat instead of re-hashing. It's best-effort and non-fatal: a `touch`/`update-index --refresh` failure logs a warning but never aborts and introduces no new exit code. A residual failure of this kind used to always surface via the exit-2 manual-resolution path above, whether or not there was actually anything to resolve -- SMI-5979 found that when this pre-flight rejection means no rebase ever started (zero conflicted files AND no active `rebase-merge`/`rebase-apply` state), the script previously still fell into the exit-2 "REBASE CONFLICT" branch and left git-crypt filters disabled with nothing to justify it. That specific case now takes a distinct exit-1 path instead: filters are restored automatically and the message says there's nothing to resolve, just retry. The exit-2 path is unchanged for a genuine conflict or an active in-progress rebase -- this mitigation (and SMI-5979's fix) only changes what happens for a residual *false-positive* rejection with nothing left to clean up.

### Manual fallback: Standard rebase (branch behind main, no squash-merge involved)

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

### Manual fallback: Post-squash wave rebase (SMI-2751)

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
   - 3b. Symlinks `.env` from main repo — Varlock needs it for `GIT_CRYPT_KEY_PATH` resolution during git-crypt unlock
4. Checks out files with decryption working
   - 4b. Initializes submodules (`docs/internal`)
   - 4c. Scans `.claude/skills/**` for encrypted files; if `.env` is present, attempts auto-unlock via `varlock run -- git-crypt unlock` before warning (SMI-2676)
   - 4d. Symlinks `node_modules` from main repo (SMI-4377) so host-side pre-commit hooks resolve `lint-staged`, `eslint`, `prettier`, `scripts/check-file-length.mjs`. Hard-errors if main repo's host `node_modules/.bin/lint-staged` is missing — fix with `(cd $REPO_ROOT && npm install --ignore-scripts)`
5. Generates Docker override file
6. Patches `.mcp.json` skillsmith entry to `npx -y @skillsmith/mcp-server` — the main repo uses a local dist path that doesn't exist in worktrees; this prevents "Failed to reconnect to skillsmith" on every worktree session
7. Idempotent backfill: ensures all existing worktrees have the Step 4d `node_modules` symlink (SMI-4377). Run standalone via `./scripts/repair-worktrees.sh`

**`.env` in worktrees**: New worktrees get `.env` auto-symlinked from the main repo (Step 3b). Existing worktrees need a manual symlink: `ln -sf /path/to/main/repo/.env .env`

**If step 4c warns**: skills like `/launchpad` Stage 4 (`hive-mind-execution`) will silently degrade until git-crypt is unlocked in the worktree. Run the printed unlock command before using `/launchpad`.

**If step 6 warns "jq unavailable"**: install jq (`brew install jq`) and re-run `create-worktree.sh`, or manually set the `skillsmith` entry in `.mcp.json` to `{"command": "npx", "args": ["-y", "@skillsmith/mcp-server"]}`.

**Existing worktrees**: Step 6 only runs during creation. If you have an existing worktree with a broken skillsmith MCP, apply the manual fix above. For the Step 4d / Step 7 `node_modules` symlink (SMI-4377), run `./scripts/repair-worktrees.sh` — idempotent, safe to re-run.

**Running commands in the worktree's container (SMI-5559)**: after `docker compose --profile dev up -d`, use `./scripts/worktree-docker.sh exec -- <cmd>` rather than a hardcoded `docker exec skillsmith-dev-1 <cmd>` — the latter is main's container name and silently "succeeds" from any worktree even when this worktree's own container never started. `worktree-docker.sh exec` resolves the container from cwd and errors loudly if it isn't running.

**Run `create-worktree.sh` from the MAIN checkout only, never from inside another worktree (SMI-6203 retro, 2026-08-28).** The script's Step 4d `node_modules` symlink (and the `.env` symlink in Step 3b) are computed relative to whatever directory the script resolves as "repository root" — inside a worktree, that resolves to the WORKTREE itself, not the main checkout. The new worktree silently ends up with `.env` symlinked to the calling worktree's own `.env` (not main's) and `node_modules` missing entirely (the relative-path computation fails and the step is skipped with only a warning, easy to miss in a long creation log). If you're already inside a worktree and need a new one, `cd` to the main checkout first — the git worktree machinery itself works fine from anywhere, only this script's own path resolution assumes it.

### `.mcp.json` skip-worktree (SMI-4973)

When `create-worktree.sh` finishes, the worktree's `.mcp.json` is
**patched in place** (the `skillsmith` MCP command swaps from
`./packages/mcp-server/dist/src/index.js` to `npx -y @skillsmith/mcp-server`
because the worktree has no built `dist/`). The script then marks the
file `skip-worktree` so `git status` stays clean despite the on-disk
divergence from HEAD.

**Verify your worktree is set up correctly**:

```bash
grep 'npx' .mcp.json          # working-tree content IS the npx form
git ls-files -v .mcp.json     # lowercase 'S' = skip-worktree set
```

**Do NOT restore `.mcp.json` to HEAD.** The HEAD content (the dist path)
does not work in a worktree — restoring it silently breaks the
skillsmith MCP. If `git diff HEAD -- .mcp.json` shows a delta, that is
expected and correct.

**Prettier-formatting (SMI-5002)**: `create-worktree.sh` Step 6 also runs
`prettier --write .mcp.json` inside the Docker container immediately after
the jq patch, so the on-disk content matches the project's prettier style
(`printWidth: 100` collapses jq's multi-line short args arrays back to
single-line). Without this step, `format:check` fails on every worktree
push (hard exit — no `continue-on-error`), forcing operators to bypass
pre-push via `SKILLSMITH_PRE_PUSH_DOCKER=1 git push --no-verify`. If the
container is down at create time, the prettier step warns and continues;
the worktree remains usable but `format:check` will fail until you run
`docker exec skillsmith-dev-1 sh -c 'cd /app/<wt-rel-path> && npx
prettier --write .mcp.json'` manually.

**`skip-worktree`, not `assume-unchanged`**: `skip-worktree` is git's
sanctioned mechanism for "I have intentionally modified this tracked
file and never want it staged." `assume-unchanged` is a performance
hint (skip the stat check) and does not guarantee the file won't be
staged. See `git update-index --help`.

**Legitimate `.mcp.json` change from a worktree** (e.g., adding a new
MCP server):

```bash
git update-index --no-skip-worktree .mcp.json   # clear the bit
# edit .mcp.json, git add, git commit, push
git update-index --skip-worktree .mcp.json      # re-set the bit
```

**Pre-existing worktrees** created before SMI-4973 landed don't have
the bit set. Run once per existing worktree:

```bash
cd .worktrees/<name>
git update-index --skip-worktree .mcp.json
```

**If the bit is ever lost** (rare; some `git reset --hard` configs can
clear it): re-set with `git update-index --skip-worktree .mcp.json`.

**Strategy submodule init in worktrees (SMI-4829)**: `create-worktree.sh` calls `init-strategy-submodules.sh` after `git submodule update --init`. This wires sparse-checkout cones for the three strategy mount-points (`.claude/skills`, `.claude/plans`, `.claude/hive-mind`). External contributors without access to `smith-horn/skillsmith-strategy` see empty mount-points but no hard error (gate #3). To re-run manually in an existing worktree: `./scripts/init-strategy-submodules.sh` from the worktree root. Team members who skipped initial setup: `git submodule update --init .claude/skills .claude/plans .claude/hive-mind` then run the init script.

**Supported worktree layouts (SMI-4654)**: Both `<repo-root>/.worktrees/<name>/` (the convention used by `create-worktree.sh`) AND nested `<repo-root>/<name>/` (worktree created directly under the repo root) are supported. `scripts/_lib.sh` computes the `node_modules` symlink depth dynamically, so either layout produces working symlinks. The `.worktrees/` convention is preferred — it keeps the repo root tidy and groups parallel work — but if you've already nested a worktree directly in the repo, you don't need to migrate it. Run `./scripts/repair-worktrees.sh` to refresh symlinks; `./scripts/verify-worktree-symlinks.sh` audits them and exits non-zero on any dangling link.

**Pre-commit hook behavior in worktrees (SMI-4377 + SMI-4381)**: The Docker `.:/app` bind-mount DOES cover `.worktrees/` (visible at `/app/.worktrees/<name>/` inside the container) — the original SMI-4377 diagnosis ("worktrees live outside `/app`") was wrong. `compute_container_wd` translates the host worktree path to its in-container equivalent. On macOS Docker Desktop, virtiofs cannot traverse the relative per-package `node_modules` symlinks, so worktree commits fall back to host execution (visible as `📂 Worktree on macOS — falling back to host execution (SMI-4381)`). The host fallback works correctly because `scripts/_lib.sh link_worktree_package_node_modules` symlinks each `packages/<pkg>/node_modules` so workspace-pinned deps (e.g. `zod@3.25.76` in `mcp-server`) resolve correctly. Linux Docker hosts use the in-container path. Off-tree worktrees (created outside `<repo-root>/.worktrees/`) also fall back to host. See `docs/internal/retros/2026-04-29-smi-4381-original-diagnosis-wrong.md` for the full RCA.

### E2E imports of `@skillsmith/*` from worktrees (SMI-4972)

A worktree's `node_modules` is a symlink to the main repo's `node_modules`
(SMI-4377/SMI-4381 — saves 5-10 GB per worktree). Inside, each
`@skillsmith/<pkg>` entry symlinks to the main repo's `packages/<pkg>/`.
Any E2E code that does `import '@skillsmith/<pkg>'` would, by default,
resolve to **main's** `packages/<pkg>/dist`, NOT the worktree's.

Unit tests are not affected — vitest's `vitest.config.ts` source-transforms
TypeScript directly and tests use relative imports (`../../src/...`).

E2E tests, however, run from `vitest.e2e.config.ts` and import via the
package name (e.g., `tests/e2e/cli/usage-counter.e2e.test.ts` imports
from `@skillsmith/core`). To prevent silent main-vs-worktree skew,
`vitest.e2e.config.ts` defines an explicit alias map that routes
`@skillsmith/core`, `@skillsmith/mcp-server`, and `@skillsmith/enterprise`
to the worktree's `packages/<pkg>/dist/src/index.js`.

**Precondition**: you must build the relevant package(s) before running
E2E from a worktree:

```bash
# SMI-5559: run via the WORKTREE's own container, not skillsmith-dev-1 (main's) —
# `docker exec skillsmith-dev-1 npm run build` here would build MAIN's packages,
# not this worktree's, defeating the point of this section.
./scripts/worktree-docker.sh exec -- npm run build
# OR for a single package:
./scripts/worktree-docker.sh exec -- npm run build --workspace=@skillsmith/core
```

**If you forget**, the test will fail with a clear `MODULE_NOT_FOUND`
pointing at the worktree's missing dist:

```text
Error: Cannot find module '/path/to/.worktrees/<name>/packages/core/dist/src/index.js'
```

This loud failure is by design — pre-SMI-4972, the missing-build state
silently fell through to main's dist, masking what the worktree was
actually testing.

**Subpath imports caveat**: `import { x } from '@skillsmith/core/errors'`
does NOT match the alias key `@skillsmith/core` and falls through to
the node_modules symlink (i.e., main's dist). No such imports exist in
`tests/e2e/` as of 2026-05-19; if you add one, extend the alias map.

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
./scripts/remove-worktree.sh .worktrees/<name> --prune
```

Includes Docker network cleanup (SMI-5000). `--force` is no longer
required for routine removal of healthy worktrees — pre-SMI-5000,
`git worktree remove` refused with "fatal: working trees containing
submodules cannot be moved or removed" because every worktree initializes
4 submodules (`docs/internal` + 3 strategy mounts). The script now passes
`--force` unconditionally to `git worktree remove` (verified empirically:
`--force` from outside the worktree does NOT modify main's `.git/config`
submodule sections), and enforces a script-level dirty-tree check to
preserve the safety that `--force` would otherwise bypass. Use `--force`
only when the worktree has uncommitted/dirty work that you want to discard.

### Worktree `git reset` Footgun (SMI-3011)

**Worktrees share branch refs with the main repo.** Running `git reset --hard` inside a worktree moves the branch pointer in every checkout of that branch.

```bash
# DANGEROUS — this also moves smi-foo in the main repo
cd .worktrees/smi-foo && git reset --hard origin/e2e-testing

# SAFE — selectively restore files without touching branch pointers
git checkout <sha> -- supabase/functions/my-fn/index.ts
```

If you need to land your Wave work after an accidental reset, use `git reflog` in the main repo to find the pre-reset commit and `git checkout <sha> -- <exclusive-files>` to restore only the files that belong to that wave.

**Key rule**: Never use `git reset` inside a worktree for file-restoration purposes. Use `git checkout <sha> -- <paths>` instead.

### Important

Git-crypt must be unlocked in the **main repo first** before creating worktrees:

```bash
cd /path/to/skillsmith
varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
git worktree add ../worktrees/my-feature -b feature/my-feature
```

### Hooks in worktrees

Pre-commit hooks work in worktrees via tracked `.husky/_/` dispatch stubs + per-package `node_modules` symlinks. One-time host setup after fresh clone: `npm install --ignore-scripts && ./scripts/repair-host-native-deps.sh`. The repair script is idempotent. Caveat: don't run `npm install` in the main repo while a pre-commit is active in a worktree.

### Worktree Docker bind-mounts (SMI-4689)

On macOS Docker Desktop, `create-worktree.sh` and `repair-worktrees.sh` emit per-package `node_modules` bind mounts into the worktree's `docker-compose.override.yml`. This masks the dangling SMI-4381 relative symlinks inside the container so `docker exec ... npm run build` resolves workspace-pinned deps correctly. Pre-commit/pre-push still use the host-fallback path (`scripts/lib/hook-docker-detect.sh`) because the symlinks themselves stay in place — they're needed for host resolution. Linux Docker hosts skip the bind-mount block (overlayfs handles the symlinks correctly). If a worktree container fails an entrypoint build with `Could not resolve <dep>` or `Cannot find module <pkg>`, run `./scripts/repair-worktrees.sh` from the main repo and restart the container.

**SMI-4738**: `npm install` in the main repo auto-regenerates worktree `docker-compose.override.yml` files via postinstall (macOS only, via `scripts/regen-worktree-overrides.sh`). Adding a new `packages/<pkg>/` no longer requires a manual `./scripts/repair-worktrees.sh` for existing worktrees to pick up the new bind mounts — just bounce the worktree container. Idempotency is content-compare (`cmp -s`), not marker-based, so drift caused by adding/removing/renaming a package is detected even when the prior override already had the SMI-4689 marker.

**Cold-start `EROFS` on the writable cache overlays (SMI-5705/SMI-5722)**: each per-package bind mount above is paired with writable overlay mounts for `.vite`/`.vite-temp` (Vite/Vitest's own dependency pre-bundle cache and config-bundling temp files) and, since SMI-5722, `.astro` (Astro's build cache) — all layered on top of the read-only `node_modules` bind so those tools can still write inside it. A Docker bind mount's source is resolved at container-**create** time; if the source directory doesn't yet exist on the host at that exact moment, the resulting mount can end up non-writable in a way only a full recreate (`docker compose --profile dev up -d --force-recreate dev`), not a plain `restart`, fixes. `ensure_build_cache_mount_sources()` (`scripts/_lib.sh`) closes this by `mkdir -p`-ing all three cache directories (root level: `.vite`/`.vite-temp` only; per-package: `.vite`/`.vite-temp`/`.astro`) both at initial worktree creation (`create-worktree.sh`) and on every `repair_worktrees_compose_override()` regen (covering the `postinstall` path too, since vite/Astro can delete and recreate these directories during normal operation after the worktree already exists).

**A manual `--force-recreate` (bypassing `repair-worktrees.sh`) can fix EROFS for some packages but not others (SMI-6202 retro, 2026-08-27)**: `ensure_build_cache_mount_sources()`'s `mkdir -p` only actually runs at the trigger points named above — a bare `docker compose --profile dev up -d --force-recreate dev` (or the `worktree-docker.sh stop`/`start` pair) does NOT itself re-run it. If some packages' `.vite-temp`/`.astro` host directories already existed from an earlier successful run and others didn't, a recreate "fixes" the former and leaves the latter still `EROFS`-broken — looking like a partial, confusing fix rather than the same root cause hitting unevenly. The reliable fix is `./scripts/repair-worktrees.sh` (safe to run from the main checkout even with another session's container active elsewhere — it never touches an active container's native bindings without `--force-with-active-docker`, and the symlink/override-regen phases run unconditionally) followed by a worktree container recreate. **Misleading secondary symptom**: when this EROFS crash happens mid-run inside a multi-package orchestration script (e.g. `.husky/../scripts/pre-push-coverage-check.sh`), it can surface as `echo: write error: Resource temporarily unavailable` on an unrelated `echo` line — a downstream pipe write failing because the upstream `vitest` process crashed hard on the `EROFS` instead of exiting cleanly. This looks exactly like a system resource-exhaustion problem (too many file descriptors, OOM) and can send debugging down the wrong path; check for `EROFS`/`.vite-temp` first by running the specific failing package's test command standalone before chasing a resource-limit theory.

### Worktree bind-mount freeze and npm-install native wipe (SMI-5375)

Two failure modes seen during a worktree session, distinct from the SMI-4689 build-override drift above:

- **Intermittent bind-mount freeze.** On macOS Docker Desktop (virtiofs) the `.worktrees/<name>` mount occasionally stops propagating edits in BOTH directions mid-session: a host edit (even a brand-new file) stays invisible inside the container, and a container write isn't seen on the host. Symptoms: a line-count / `wc -l` gate reads a STALE file (e.g. a file you already split still reports its old length), `prettier --check <touched>` reports "No files matching the pattern", a test run executes stale source. It self-resolves later and is NOT reliably cleared by `docker compose restart` / `down`+`up`. **Workaround**: sync explicitly with `docker cp <hostfile> <container>:/app/<path>` (or the reverse), then re-run the in-container check. The pre-commit hook runs host-side (SMI-4381/4681), so commits read the correct HOST files — only in-CONTAINER verification is fooled; trust the host (and CI) over a frozen container.

  **`docker cp` success does NOT prove the file synced (SMI-5569).** A `docker cp` can exit 0 with no stderr and still silently no-op under the same virtiofs freeze — non-deterministically, on a SUBSET of a batch. In the SMI-5569 incident a single `for f in ...; do docker cp ...; done` loop over 16 touched files exited 0 for every file, yet 8 remained pre-edit inside the container; re-`docker cp`-ing just those 8 fixed them. This produced a false-positive "73/73 tests green" run that was actually exercising stale source (including a `recommend.format.ts` that did not yet contain the feature under test), and two separate background subagents independently reported the same "all green" before a manual content-diff caught it. This is the "invisible success" failure mode — treat a clean `docker cp` as unverified until proven otherwise:

  - **Verify by CONTENT, not line count.** `wc -l` is insufficient — the SMI-5569 stale set included a Vitest `.snap` file with the SAME line count as the host but different content (an inline description string had changed inside one JSON line), which any `wc -l` check passes while still stale. After EVERY `docker cp`, diff the actual bytes: `diff -q <hostfile> <(docker exec <container> cat /app/<relpath>)`. Any non-empty / non-zero result = still stale: re-`docker cp` and re-`diff -q` that file until it is clean. Do not retry blind — confirm each retry with its own diff. Only trust a test / lint / build run once every touched file diffs clean.
  - **Use one long-lived container; do NOT rely on `docker compose run --rm`.** A `--rm` run (used elsewhere in these runbooks, e.g. as a workaround against a restart-looping container) mints a FRESH container that remounts the same bind mount from scratch, so if the staleness lives at the virtiofs mount layer — not just one long-lived container's cached view — an ephemeral run does NOT reliably clear it, and the file you `docker cp`'d into one `run` is gone in the next invocation. Reliable pattern: use a container you can `docker exec` into repeatedly (the named worktree `dev` service, or a detached one you start explicitly, e.g. `docker compose run --rm -d --entrypoint sh dev -c "sleep 300"`), `docker cp` every file that must be current into THAT SAME container, `diff -q`-verify each, and only then run tests/lint/build via `docker exec` against THAT SAME container — never a fresh `run`.
  - **Background agents and subagents are not exempt.** Any agent (not just an interactive session) doing worktree-container verification that reports "tests pass" must content-diff its touched files first — the SMI-5569 false positive was reproduced independently by two background subagents that trusted their own green run.
- **Never `npm install` in a worktree container to "fix" a transient build/native blip.** `.npmrc` sets `ignore-scripts=true` (SMI-5200), so a bare `npm install` leaves `better-sqlite3` (and `onnxruntime-node` / `hnswlib-node`) uncompiled — "Native SQLite module (better-sqlite3) is not available" across core/mcp-server/enterprise — and can drop `packages/*/dist`. To clear a transient error, `docker compose --profile dev restart dev` (or `DEV_PORT=<alt> docker compose --profile dev restart dev` for a worktree container): the entrypoint self-heals all native modules on restart (SMI-5351). If you DID install (real lockfile drift), follow with `npm rebuild better-sqlite3 onnxruntime-node hnswlib-node --ignore-scripts=false` AND `npm run build` to restore `dist/`.

### In-container git discovery from a worktree is unsupported (SMI-5144)

A worktree's `/app/.git` is a pointer **file** (`gitdir: <host-abs>/.git/worktrees/<name>`), and a worktree dev container bind-mounts **only the worktree subtree** at `/app` — the main repo's `.git` is absent in-container. So `git` run from `/app` inside a worktree container fails with `fatal: not a git repository … exit 128` (same SMI-4689 class). `docker exec` forwards no host env, so this is **not** a `GIT_*` leak. The entrypoint prints a non-fatal YELLOW advisory in this case; the main-repo container is unaffected (there `/app/.git` is a directory). **Implications**: run git on the host (`git push` always originates on host anyway), and never write a test that does git discovery from `process.cwd()` — build a self-created fixture repo instead (the SMI-5140 hermetic pattern). A static guard in `scripts/tests/git-fixture-isolation.test.ts` (SMI-5144) fails CI if a test reintroduces the `git`-spawn-with-`cwd: process.cwd()` pattern.

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

---

## Working with docs/internal (Submodule) — SMI-3009

`docs/internal/` is a private git submodule with its own commit history. You **cannot** stage files inside it from the main repo:

```bash
# ❌ This fails — always
git add docs/internal/adr/110-foo.md
# fatal: Pathspec 'docs/internal/adr/110-foo.md' is in submodule 'docs/internal'
```

### Correct Workflow

```bash
# 1. Commit inside the submodule using absolute path (CRITICAL: avoid cd persistence)
cd /Users/williamsmith/Documents/GitHub/Smith-Horn/skillsmith/docs/internal
git add adr/110-foo.md retros/2026-03-03-bar.md code_review/2026-03-03-baz.md
git commit -m "docs: add ADR-110, retro, and code review"

# 2. Return to main repo and stage the updated submodule pointer
cd /Users/williamsmith/Documents/GitHub/Smith-Horn/skillsmith
git add docs/internal
git commit -m "chore(docs): update internal submodule pointer"
```

### Path Discipline

**Always use absolute paths** when switching between the main repo and the submodule. The shell cwd persists across Bash tool calls. If you `cd docs/internal` and forget to switch back, subsequent `git branch --show-current` will show the submodule's `main` branch rather than your feature branch.

```bash
# ✅ Safe — explicit absolute path
git -C /Users/williamsmith/Documents/GitHub/Smith-Horn/skillsmith status

# ❌ Risky — cwd may still be inside docs/internal/
git status
```

### Verifying Submodule State

```bash
# Check submodule pointer is staged
git -C /path/to/skillsmith diff --cached docs/internal

# Check submodule's HEAD (should be the commit you just made)
git -C /path/to/skillsmith/docs/internal log --oneline -1
```

### `git submodule update --init docs/internal` stalls indefinitely in a fresh worktree (SMI-6015 session, 2026-08-13)

A brand-new worktree's `docs/internal` clone over HTTPS can stall for 20+ minutes with near-zero CPU (`ps -o etime,time` shows large elapsed time, near-zero accumulated CPU — genuinely blocked on network I/O, not just slow). Killing and retrying reproduces the same stall; running multiple retries without killing the prior attempt's orphaned `git index-pack`/`git-remote-https` processes makes it worse, since they all compete for the same connection. This is independent of repo size — `docs/internal`'s object store is only ~80MB.

**Fix**: skip the network clone entirely. The main checkout already has a complete local copy of `docs/internal`'s object database at `.git/modules/docs/internal` — clone from that via `file://` instead, then re-point the remote at the real GitHub URL:

```bash
# From the new worktree's root, after killing any stalled clone processes
# (ps aux | grep skillsmith-docs, kill -9 the git/index-pack/remote-https PIDs)
rm -rf docs/internal/.git docs/internal/*
mkdir -p docs/internal
mkdir -p /path/to/skillsmith/.git/worktrees/<worktree-name>/modules/docs
git clone --no-checkout \
  --separate-git-dir=/path/to/skillsmith/.git/worktrees/<worktree-name>/modules/docs/internal \
  file:///path/to/skillsmith/.git/modules/docs/internal \
  docs/internal

cd docs/internal
git remote set-url origin https://github.com/smith-horn/skillsmith-docs.git
git reset --hard HEAD   # --no-checkout leaves the working tree empty; this populates it
```

This is instant (local filesystem copy, no network) and produces a submodule checkout indistinguishable from what `git submodule update --init` would have made — `git submodule status` recognizes it normally afterward. The main checkout's `main` branch must already be fetched-current for this to hand the worktree a fully up-to-date object store.

## Host Native Bindings & SessionStart Instrumentation (SMI-4549)

**One-time host setup required** (after fresh clone):

```bash
npm install --ignore-scripts             # populate $REPO_ROOT/node_modules (Docker volumes don't)
./scripts/repair-host-native-deps.sh     # SMI-4549: rebuild better-sqlite3 binding (--ignore-scripts skipped it)
```

The repair script is idempotent — sub-second `[skip]` exit when the binding already loads. Skipping it leaves the host's retrieval-logs writer (`packages/doc-retrieval-mcp/src/retrieval-log/writer.ts`) silently no-op-ing, which the SMI-4549 retro caught after a 7-day soak window passed with zero captured rows.

**`IS_DOCKER` trap (SMI-4549)**: The retrieval-logs writer no-ops when `process.env.IS_DOCKER === 'true'` because Docker has its own writer path. If you `export IS_DOCKER=true` in a host shell (e.g. sourced from `.env.docker`), the writer will refuse to write on the host too — matching the same zero-rows symptom as a missing native binding. Verify with `printenv IS_DOCKER` (must be empty on host) before debugging instrumentation.

**Outage marker + stale-instrumentation banner (SMI-4549 Wave 2)**: When the writer enters a no-op branch the user is expected to remediate (binding load failure, owner mismatch — but NOT the Docker no-op, which is the documented "I don't write" mode), it writes `<projectDir>/retrieval-log.outage.json` (mode 0600, atomic). The next SessionStart hook reads the marker via `packages/doc-retrieval-mcp/src/retrieval-log/probe.ts` (which never imports `better-sqlite3` at module top level so a broken binding can't crash the hook) and prepends a `**Warning — SessionStart instrumentation appears stale.**` banner to `additionalContext`. The marker self-clears on the next successful open, or after 7 days. Stand-alone probe: `./scripts/check-retrieval-events.sh` (exit 0=healthy, 1=stale, 2=probe failed). Escape hatch: `SKILLSMITH_RETRIEVAL_PROBE_DISABLE=1`. **Diagnostic order before assuming the writer is dead: (1) check the marker file, (2) `printenv IS_DOCKER`, (3) probe the binding via `node -e "new (require('better-sqlite3'))(':memory:').close()"`.**

**macOS + worktree → host fallback (SMI-4377 + SMI-4381 + SMI-4549 + SMI-4681 + SMI-4686)**: detection logic lives in one place — `scripts/lib/hook-docker-detect.sh` — sourced by all four hook callers (`.husky/pre-commit`, `.husky/pre-push`, `scripts/pre-push-check.sh`, `scripts/pre-push-coverage-check.sh`). When you see one of these messages on macOS:

```text
📂 Worktree on macOS — falling back to host execution (SMI-4381 / SMI-4681)
   Per-package node_modules symlinks are not traversable in
   Docker Desktop's virtiofs. Host resolution works correctly.
```

…it is **expected** and the hook is doing the right thing. If the message is followed by `❌ Host node_modules missing in worktree.`, run `./scripts/repair-worktrees.sh` to backfill the symlinks + native bindings.

**Escape hatch — `SKILLSMITH_PRE_PUSH_DOCKER=1` (SMI-4767)**: the host fallback above is correct for `pre-commit` (lint/format) but breaks `pre-push` test runs because the parent vitest invocation in `scripts/pre-push-coverage-check.sh` still inherits parent-worktree `GIT_*` env. SMI-4693 only landed Waves 1–3 (test-fixture env scrub via `git-fixture-env`); the parent-vitest leak is deferred to SMI-4769. Workaround: prepend `SKILLSMITH_PRE_PUSH_DOCKER=1` to the push to force Docker even on macOS worktrees, bypassing this fallback for pre-push only:

```bash
SKILLSMITH_PRE_PUSH_DOCKER=1 git push        # per-invocation (preferred)
export SKILLSMITH_PRE_PUSH_DOCKER=1          # session-wide if pushing repeatedly
```

Docker must be running — the hook prints a red error + `exit 1` if `SKILLSMITH_PRE_PUSH_DOCKER=1` is set but the dev container is down. Do NOT use `git push --no-verify` as the default; that bypasses *all* pre-push checks (security scan, format check, etc.), not just the leaky vitest. The env-var workaround is targeted.

**Escape hatch — `SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1` (SMI-4931)**: `scripts/pre-push-coverage-check.sh` runs each of the five vitest suites inside its own process group (`set -m`) and SIGKILLs that group after the suite finishes, so leaked worker/child processes cannot accumulate and flake later suites. If that process-group sweep ever misbehaves, set `SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1` to revert Phase 4 to the plain unwrapped invocation — a Phase-4-scoped fallback that, unlike `git push --no-verify`, keeps every other pre-push check active. This is orthogonal to `SKILLSMITH_PRE_PUSH_DOCKER` (which addresses the parent-worktree `GIT_*` env leak, SMI-4769); the two can be combined.

**Escape hatch — `SKILLSMITH_PRE_PUSH_HOST=1` (SMI-5570/SMI-5074)**: falls back pre-push execution to the host — but ONLY when the worktree's own dedicated container isn't detected as running at all (`hook-docker-detect.sh`'s `DOCKER_AVAILABLE=0` gate, `scripts/lib/hook-docker-detect.sh:221-234`). If the container IS up but internally unhealthy (e.g. the SMI-5635 read-only-mount native-module/symlink defect), this var is a no-op: `USE_DOCKER` stays 1 and every pre-push phase — security suite, format, coverage/tests — still runs in the broken container. There is no flag that forces host execution over an already-running-but-broken container; the only paths in that situation are fixing the container directly (e.g. `docker exec -w /app/packages/<pkg> <container> npm rebuild <module> --ignore-scripts=false` for native-module breakage) or `git push --no-verify`.

**Caveat (SMI-4698)**: the **native-rebuild step** of `./scripts/repair-worktrees.sh` aborts if a `skillsmith*-dev-N` container is running — it would otherwise overwrite the container's ELF native bindings via the symlinked `node_modules`. Symlink-repair steps run safely regardless. Stop the container first (`docker compose --profile dev down`), or pass `--force-with-active-docker` and run `docker exec -w /app skillsmith-dev-1 npm rebuild better-sqlite3 onnxruntime-node` afterward to restore the container's bindings.
