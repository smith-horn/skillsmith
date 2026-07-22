/**
 * Fixture/shim infrastructure for rebase-worktree.test.ts (SMI-5773). Split
 * out per CLAUDE.md's 500-line file-length guidance — see the sibling test
 * file's header for the full rationale. Follows the same `.test.ts` +
 * `.helpers.ts` split convention introduced for
 * prune-orphaned-docker-volumes.test.ts/.helpers.ts (SMI-5750, PR #1968).
 *
 * Two families of helpers live here:
 *
 *  1. The original SMI-3102 black-box helpers (`runScript`, `git`, `sh`,
 *     `setupRepoWithWorktree`) — spawn the real script as a subprocess and
 *     assert on its stdout/stderr/exit code, same as every pre-SMI-5773 test.
 *
 *  2. New SMI-5773 helpers for git-crypt simulation and direct function-level
 *     testing:
 *       - `setupGitCryptFixture()` registers a portable, reversible filter
 *         pair (clean: prepend `\0GITCRYPT`; smudge: strip it) via
 *         `.gitattributes` + local git config, standing in for real
 *         git-crypt (no git-crypt binary or key material needed).
 *       - `sourceAndRun()` sources the real `scripts/rebase-worktree.sh`
 *         (which, per SMI-5773, no longer auto-runs `main()` when sourced —
 *         see the file's trailing `BASH_SOURCE[0]`-guard) and invokes one or
 *         more of its functions (`restore_filter_config`, `force_resmudge`,
 *         `scan_ciphertext`) directly against a caller-supplied fixture
 *         state. This tests the REAL functions, not shell reimplementations.
 *       - `backdateMtime()` is the deterministic (non-flaky) trigger for
 *         git's stat-clean-skip mechanism that the regression/detector tests
 *         depend on. Full mechanism explanation lives as a comment at each
 *         call site in rebase-worktree.test.ts — summary: git's
 *         `checkout_entry_ca()` calls `ie_match_stat()` WITHOUT
 *         `CE_MATCH_RACY_IS_DIRTY`, so a "racy" cache entry (one whose cached
 *         mtime is not safely older than the index file's own last-write
 *         time — true for any fast back-to-back sequence, which is exactly
 *         what a synthetic test naturally produces) falls through to an
 *         actual content re-verification instead of trusting the stat, and
 *         that re-verification happens to self-correct in this specific
 *         repro shape. Backdating the file's mtime (then `git update-index
 *         --refresh` to re-cache it) reproduces the genuinely non-racy state
 *         a real multi-second script run naturally has, without relying on
 *         wall-clock timing in the test itself.
 */

import { execSync, spawnSync } from 'child_process'
import { mkdirSync, utimesSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

export const SCRIPT_PATH = join(__dirname, '..', 'rebase-worktree.sh')

/** SMI-4693: GIT_DISCOVERY_VARS-stripped env for every git invocation AND the script subprocess. */
export const GIT_ENV = makeFixtureEnv()

export function makeTempDir(prefix: string): string {
  return makeFixtureTempDir(prefix)
}

export function git(cwd: string, args: string): string {
  return execSync(`git -c init.defaultBranch=main -c protocol.file.allow=always ${args}`, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

export function sh(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: 'utf8', env: GIT_ENV, ...opts }).trim()
}

/**
 * Run the rebase-worktree.sh script, returning { status, stdout, stderr }.
 * `extraEnv` merges over GIT_ENV -- used by the SMI-5781 end-to-end
 * regression test to enable the force_racy_stash_restore_for_test()
 * determinism seam (SKILLSMITH_REBASE_FORCE_RACY_TEST=1) without every
 * other call site needing to know about it.
 */
export function runScript(
  args: string,
  extraEnv: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash "${SCRIPT_PATH}" ${args}`, {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...GIT_ENV, ...extraEnv },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

export interface RepoWithWorktree {
  bareDir: string
  cloneDir: string
  worktreeDir: string
}

/**
 * Create a bare "remote" repo, clone it, make an initial commit,
 * push to origin, and create a worktree on a feature branch.
 */
export function setupRepoWithWorktree(tempRoot: string): RepoWithWorktree {
  const bareDir = join(tempRoot, 'bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')

  git(tempRoot, `init --bare "${bareDir}"`)
  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)

  sh(`touch "${join(cloneDir, 'README.md')}"`)
  git(cloneDir, 'add README.md')
  git(cloneDir, 'commit -m "initial commit"')
  git(cloneDir, 'push origin main')

  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)

  return { bareDir, cloneDir, worktreeDir }
}

export interface SubmoduleRepoFixture {
  bareDir: string
  subBareDir: string
  cloneDir: string
  worktreeDir: string
}

/**
 * Shared bare-repo + submodule + worktree bootstrap used by the SMI-3102
 * submodule scenarios (submodule pointer update, --no-submodule, submodule
 * ahead-of-target, strict-descendant + --allow-submodule-ahead, diverged
 * submodule). Creates bare.git (main) + sub-bare.git (submodule), seeds the
 * submodule with one commit, clones main, `submodule add`s it at
 * docs/internal, creates a `feature` worktree, and initializes the
 * submodule inside it. Callers advance main/submodule however their
 * scenario needs from there.
 */
export function setupSubmoduleRepoWithWorktree(tempRoot: string): SubmoduleRepoFixture {
  const bareDir = join(tempRoot, 'bare.git')
  const subBareDir = join(tempRoot, 'sub-bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')

  git(tempRoot, `init --bare "${bareDir}"`)
  git(tempRoot, `init --bare "${subBareDir}"`)

  const subSeedDir = join(tempRoot, 'sub-seed')
  git(tempRoot, `clone "${subBareDir}" "${subSeedDir}"`)
  sh(`touch "${join(subSeedDir, 'doc.md')}"`)
  git(subSeedDir, 'add doc.md')
  git(subSeedDir, 'commit -m "sub initial"')
  git(subSeedDir, 'push origin main')

  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
  sh(`touch "${join(cloneDir, 'README.md')}"`)
  git(cloneDir, 'add README.md')
  git(cloneDir, 'commit -m "initial"')
  git(cloneDir, `submodule add "${subBareDir}" docs/internal`)
  git(cloneDir, 'commit -m "add submodule"')
  git(cloneDir, 'push origin main')

  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
  git(worktreeDir, 'submodule update --init')

  return { bareDir, subBareDir, cloneDir, worktreeDir }
}

/**
 * SMI-5773: register a portable, reversible filter pair that stands in for
 * git-crypt, exactly as specified by the plan doc's Verification section —
 * clean prepends a 9-byte `\0GITCRYPT` magic header, smudge strips it back
 * off. Applies to `cwd` (a real git repo/worktree) for every path under
 * `encPrefix` via `.gitattributes` (parsed by the script's own
 * `get_encrypted_paths()`).
 *
 * Must be called BEFORE any file under `encPrefix` is `git add`ed, so the
 * clean filter is in effect at commit time (mirrors how real git-crypt
 * repos are set up).
 */
export function setupGitCryptFixture(cwd: string, encPrefix: string): void {
  git(cwd, `config filter.git-crypt.clean 'printf "\\000GITCRYPT"; cat'`)
  git(cwd, `config filter.git-crypt.smudge 'tail -c +10'`)
  const gitattributesPath = join(cwd, '.gitattributes')
  writeFileSync(gitattributesPath, `${encPrefix}/** filter=git-crypt\n`, { flag: 'a' })
  mkdirSync(join(cwd, encPrefix), { recursive: true })
}

/** Disable the git-crypt filter pair (simulates the script's Step 7). */
export function disableGitCryptFilters(cwd: string): void {
  git(cwd, `config filter.git-crypt.smudge cat`)
  git(cwd, `config filter.git-crypt.clean cat`)
}

/** Restore the real git-crypt filter pair (simulates restore_filter_config's config half). */
export function restoreGitCryptFilters(cwd: string): void {
  git(cwd, `config filter.git-crypt.smudge 'tail -c +10'`)
  git(cwd, `config filter.git-crypt.clean 'printf "\\000GITCRYPT"; cat'`)
}

/**
 * SMI-5773: deterministically construct a non-racy cache entry so git's
 * checkout_entry_ca() trusts the stat comparison (see file header for the
 * full mechanism). Backdates the file's mtime via Node's utimesSync (no
 * GNU/BSD `touch -d` portability concerns), then `git update-index
 * --refresh` re-caches that backdated mtime into the index — legitimate
 * because the file's actual content hash is unchanged (only the timestamp
 * moved), so refresh accepts it as the new "clean" baseline.
 */
export function backdateMtime(cwd: string, relPath: string, secondsAgo = 3600): void {
  const past = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(join(cwd, relPath), past, past)
  git(cwd, `update-index -q --refresh`)
}

/**
 * SMI-5773: same racy-git mechanism as `backdateMtime()` (see file header),
 * applied at fixture-setup time rather than to prove the bug. A worktree
 * created via `git worktree add` moments before the real script disables
 * git-crypt filters (Step 7) has a RACY cache entry for every pre-existing
 * tracked file under the encrypted-path glob -- so the disable alone (a
 * config-only change, no file write) makes `git rebase`'s own pre-flight
 * "clean working tree" check force a content re-verification, which
 * naturally mismatches under the now-identity clean filter and produces a
 * spurious "You have unstaged changes" failure for a file the test never
 * touched. Backdating every tracked path under `pathPrefix` right after
 * worktree creation (well before Step 7 runs) defeats this the same way
 * `backdateMtime()` defeats it for the residue-detection mechanism itself --
 * without this, tests combining "git-crypt fixture" + "run the real script"
 * are flaky/broken independent of anything SMI-5773 is meant to verify.
 */
export function backdateTrackedPath(worktreeDir: string, pathPrefix: string): void {
  const files = git(worktreeDir, `ls-files -- ${pathPrefix}`)
    .split('\n')
    .filter((f) => f.length > 0)
  const past = new Date(Date.now() - 3600 * 1000)
  for (const f of files) {
    utimesSync(join(worktreeDir, f), past, past)
  }
  if (files.length > 0) {
    git(worktreeDir, `update-index -q --refresh`)
  }
}

/**
 * SMI-5773: the exact pre-fix `restore_filters()` re-checkout sequence
 * (config restore + a bare `checkout HEAD -- <paths>`, no rm) — kept here,
 * inline, ONLY to prove the regression mechanism in the "red on old code"
 * half of the regression/detector tests. Not sourced from the real script
 * because that code path no longer exists there (it was replaced, not
 * kept behind a flag, per the plan).
 */
export function preFixResmudge(worktreeDir: string, encPaths: string): void {
  restoreGitCryptFilters(worktreeDir)
  // shellcheck-equivalent unquoted expansion intentional -- mirrors the
  // removed buggy code exactly (see scripts/rebase-worktree.sh git history).
  sh(`git checkout HEAD -- ${encPaths} 2>/dev/null || true`, { cwd: worktreeDir })
}

export interface SourceAndRunResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * SMI-5773: source the real rebase-worktree.sh (main() auto-run is guarded
 * off when sourced, see the script's trailing BASH_SOURCE check) and invoke
 * one or more of its functions directly against a caller-built fixture
 * state. `setup` lines run after sourcing but before `call` — typically
 * assigning WORKTREE_PATH and any other globals the target function reads
 * (HAS_GIT_CRYPT, FILTERS_DISABLED, ORIG_SMUDGE/ORIG_CLEAN). `call` is the
 * actual function invocation(s); stdout is used for assertions, so print
 * anything the test needs (e.g. `printf '%s\n' "${SCAN_RESULT_BAD[@]}"`).
 */
export function sourceAndRun(params: {
  worktreeDir: string
  setup?: string[]
  call: string
}): SourceAndRunResult {
  const { worktreeDir, setup = [], call } = params
  const wrapper = [
    'set -uo pipefail',
    `source "${SCRIPT_PATH}"`,
    `WORKTREE_PATH="${worktreeDir}"`,
    ...setup,
    call,
  ].join('\n')
  const result = spawnSync('bash', ['-c', wrapper], {
    encoding: 'utf8',
    timeout: 30_000,
    env: GIT_ENV,
  })
  return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * SMI-5773: drives Steps 6/7/9/10 (stash, disable filters, real `git
 * rebase`, restore filters) by hand for the encrypted-path stash-interplay
 * test -- `git stash push`'s own internal checkout re-primes raciness for
 * whatever it just restored to HEAD (see rebase-worktree.test.ts's header
 * comment), so a pre-`runScript()` backdate can't reach it; this must
 * backdate again in between. Leaves the stash in place (caller does Step 11
 * -- `git stash pop` -- after asserting on the intermediate state).
 */
export function stashDisableRebaseRestore(worktreeDir: string, targetRef = 'origin/main'): void {
  git(worktreeDir, 'stash push -m "test wip"')
  backdateTrackedPath(worktreeDir, 'enc')
  disableGitCryptFilters(worktreeDir)
  execSync(`git rebase ${targetRef}`, {
    cwd: worktreeDir,
    env: { ...GIT_ENV, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
  })
  restoreGitCryptFilters(worktreeDir)
}

/** Read the first 9 bytes of a file and report whether it's the `\0GITCRYPT` sentinel. */
export function hasCiphertextPrefix(absPath: string): boolean {
  const buf = sh(`head -c 9 "${absPath}" | LC_ALL=C tr -d '\\0'`)
  return buf === 'GITCRYPT'
}

export interface GitCryptRepoFixture {
  bareDir: string
  cloneDir: string
  worktreeDir: string
}

/**
 * Shared bare+clone+worktree bootstrap for the SMI-5773 non-rebase-residue
 * tests (missing-tracked-file, untracked-file-safety, stash interplay).
 * Registers the git-crypt filter simulation, writes+commits each entry in
 * `files` (repo-relative path -> content), and creates a `feature`
 * worktree. Caller advances origin/main and/or edits the worktree from there.
 */
export function setupGitCryptRepoWithWorktree(
  tempRoot: string,
  files: Record<string, string> = { 'enc/file.txt': 'v1' }
): GitCryptRepoFixture {
  const bareDir = join(tempRoot, 'bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')

  git(tempRoot, `init --bare "${bareDir}"`)
  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
  setupGitCryptFixture(cloneDir, 'enc')
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(cloneDir, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${content}\n`)
  }
  git(cloneDir, `add .gitattributes ${Object.keys(files).join(' ')}`)
  git(cloneDir, 'commit -m "initial"')
  git(cloneDir, 'push origin main')
  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
  // See backdateTrackedPath()'s doc comment: without this, the real script's
  // Step 7 filter-disable makes any pre-existing tracked encrypted file look
  // spuriously modified to git rebase's own pre-flight clean-tree check.
  backdateTrackedPath(worktreeDir, 'enc')

  return { bareDir, cloneDir, worktreeDir }
}

export interface ResidueFixture {
  tempRoot: string
  worktreeDir: string
  cloneDir: string
  filePath: string
  relPath: string
  mergeBase: string
  targetSha: string
}

/**
 * SMI-5773: shared builder for the regression + detector tests. Creates a
 * real bare/clone/worktree trio, registers the git-crypt filter simulation,
 * gives the worktree branch its own local commit (so the eventual rebase is
 * a genuine replay, not a fast-forward -- matches the real SMI-5750 shape of
 * a worktree branch with local commits rebasing onto an advanced main),
 * advances origin/main's encrypted file, then drives Steps 7+9 for real
 * (disable filters, run an actual `git rebase`) and backdates the rewritten
 * file's mtime so the stat-clean-skip mechanism is deterministically
 * triggered rather than relying on incidental test-run timing (see this
 * file's header for the racy-git mechanism this defeats).
 *
 * Returns with filters still DISABLED and the file holding raw ciphertext --
 * callers restore filters (via preFixResmudge or restoreGitCryptFilters) and
 * exercise the old-vs-new re-smudge behavior from there.
 */
export function buildRebaseResidueFixture(tempRoot: string): ResidueFixture {
  const bareDir = join(tempRoot, 'bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')
  const relPath = 'enc/file.txt'

  git(tempRoot, `init --bare "${bareDir}"`)
  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
  setupGitCryptFixture(cloneDir, 'enc')
  sh(`echo "v1" > "${join(cloneDir, relPath)}"`)
  git(cloneDir, 'add .gitattributes enc/file.txt')
  git(cloneDir, 'commit -m "initial"')
  git(cloneDir, 'push origin main')

  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
  // See backdateTrackedPath()'s doc comment: without this, disabling
  // filters below makes the just-checked-out enc/file.txt look spuriously
  // modified to git rebase's own pre-flight clean-tree check, failing
  // before the rebase (and thus Step 9's real internal mechanism) ever runs.
  backdateTrackedPath(worktreeDir, 'enc')

  // Give feature its own local commit unrelated to the encrypted path, so
  // the rebase performs a genuine replay (not a fast-forward).
  sh(`echo "feature work" > "${join(worktreeDir, 'other.txt')}"`)
  git(worktreeDir, 'add other.txt')
  git(worktreeDir, 'commit -m "feature: unrelated change"')

  git(cloneDir, 'checkout main')
  sh(`echo "v2 from main" > "${join(cloneDir, relPath)}"`)
  git(cloneDir, 'add enc/file.txt')
  git(cloneDir, 'commit -m "advance main: change encrypted file"')
  git(cloneDir, 'push origin main')
  git(worktreeDir, 'fetch origin main')

  const mergeBase = git(worktreeDir, 'merge-base HEAD origin/main')
  const targetSha = git(worktreeDir, 'rev-parse origin/main')

  disableGitCryptFilters(worktreeDir)
  execSync('git rebase origin/main', {
    cwd: worktreeDir,
    env: { ...GIT_ENV, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
  })

  const filePath = join(worktreeDir, relPath)
  backdateMtime(worktreeDir, relPath)

  return { tempRoot, worktreeDir, cloneDir, filePath, relPath, mergeBase, targetSha }
}

export interface SubmoduleAheadFixture {
  worktreeDir: string
  cloneDir: string
  encFilePath: string
}

/**
 * SMI-5773: trap-safety fixture. `step_rebase_submodule` (Step 8) is the
 * only step between Step 7's `trap restore_filter_config EXIT` registration
 * and Step 9's `trap - EXIT` clear that can itself fail (`error()` on a
 * submodule pointer that's ahead of target) -- so a submodule-ahead
 * divergence is what's needed to observe the EXIT trap actually firing
 * with filters genuinely disabled. Also registers the git-crypt filter
 * simulation so there's a real filter pair for the trap to restore.
 */
export function setupSubmoduleAheadGitCryptFixture(tempRoot: string): SubmoduleAheadFixture {
  const bareDir = join(tempRoot, 'bare.git')
  const subBareDir = join(tempRoot, 'sub-bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')

  git(tempRoot, `init --bare "${bareDir}"`)
  git(tempRoot, `init --bare "${subBareDir}"`)

  const subSeedDir = join(tempRoot, 'sub-seed')
  git(tempRoot, `clone "${subBareDir}" "${subSeedDir}"`)
  sh(`touch "${join(subSeedDir, 'doc.md')}"`)
  git(subSeedDir, 'add doc.md')
  git(subSeedDir, 'commit -m "sub initial"')
  git(subSeedDir, 'push origin main')

  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
  setupGitCryptFixture(cloneDir, 'enc')
  sh(`echo "v1" > "${join(cloneDir, 'enc', 'file.txt')}"`)
  git(cloneDir, 'add .gitattributes enc/file.txt')
  git(cloneDir, 'commit -m "initial"')
  git(cloneDir, `submodule add "${subBareDir}" docs/internal`)
  git(cloneDir, 'commit -m "add submodule"')
  git(cloneDir, 'push origin main')

  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
  git(worktreeDir, 'submodule update --init')

  // Advance the worktree's submodule AHEAD of main's pointer.
  const wtSub = join(worktreeDir, 'docs', 'internal')
  sh(`echo "ahead content" > "${join(wtSub, 'ahead.md')}"`)
  git(wtSub, 'add ahead.md')
  git(wtSub, 'commit -m "worktree sub ahead"')

  // Advance main (non-submodule, encrypted-path change) so the rebase is
  // needed and Step 7 genuinely disables filters before Step 8 fails.
  git(cloneDir, 'checkout main')
  sh(`echo "v2 from main" > "${join(cloneDir, 'enc', 'file.txt')}"`)
  git(cloneDir, 'add enc/file.txt')
  git(cloneDir, 'commit -m "advance main"')
  git(cloneDir, 'push origin main')
  git(cloneDir, 'checkout -')

  return { worktreeDir, cloneDir, encFilePath: join(worktreeDir, 'enc', 'file.txt') }
}
