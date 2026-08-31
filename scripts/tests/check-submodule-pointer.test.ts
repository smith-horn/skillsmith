/**
 * SMI-6260 Wave 1 — scripts/ci/check-submodule-pointer.sh test suite.
 *
 * One case per rule (R0-R11 + R-FETCH) from the plan's binding accept/reject
 * table, using small local bare-repo git fixtures with REAL commits forming
 * real ancestor/descendant/diverged/orphaned graphs — never mocked git
 * command output. This is exactly the "SQL/graph-correctness-shaped logic"
 * CLAUDE.md's SMI-6015 lesson warns gets reviewed but never tested if
 * coverage is skipped.
 *
 * Every fixture follows the same shape: a bare "sub-remote.git" (the
 * submodule's own upstream), a "seed" working clone used to create
 * additional commits/branches on that remote, a "parent" repo (a tiny
 * stand-in for skillsmith itself) with a .gitmodules registering
 * docs/internal, and docs/internal itself as a real clone of sub-remote.git
 * inside parent — i.e. a genuinely initialized submodule checkout, not a
 * simulated one. check-submodule-pointer.sh is invoked as a real child
 * process (spawnSync) against the parent fixture, exactly as CI/pre-push
 * would invoke it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'check-submodule-pointer.sh')

const FAKE_SHA_1 = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const FAKE_SHA_2 = 'cafef00d'.repeat(5) // 40 hex chars

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: makeFixtureEnv() }).trim()
}

function initRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', branch)
  git(dir, 'config', 'commit.gpgsign', 'false')
}

function commitFile(dir: string, relPath: string, content: string, message: string): string {
  writeFileSync(join(dir, relPath), content)
  git(dir, 'add', relPath)
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

interface Fixture {
  root: string
  subRemoteDir: string
  seedDir: string
  parentDir: string
  mountDir: string
  branch: string
  /** The seed commit BEFORE T — a valid, resolvable ancestor of everything below. */
  base: string
  /** The submodule's upstream tip at fixture-build time. */
  T: string
}

/**
 * Build the standard fixture: a bare sub-remote with two commits on
 * `branch` (base -> T, both pushed), a "seed" working clone of it (for
 * creating further branches/commits per-test), and a "parent" repo with
 * docs/internal already a real, initialized clone of sub-remote — i.e. the
 * mount's local checkout has already fetched `base` and `T` by construction.
 */
function buildFixture(branch = 'main'): Fixture {
  const root = makeFixtureTempDir('csp-fixture')
  const subRemoteDir = join(root, 'sub-remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, subRemoteDir], {
    env: makeFixtureEnv(),
  })

  const seedDir = join(root, 'seed')
  initRepo(seedDir, branch)
  const base = commitFile(seedDir, 'f0.txt', 'base\n', 'base commit')
  git(seedDir, 'remote', 'add', 'origin', subRemoteDir)
  git(seedDir, 'push', '-q', 'origin', branch)
  const T = commitFile(seedDir, 'f1.txt', 'tip\n', 'T commit')
  git(seedDir, 'push', '-q', 'origin', branch)

  const parentDir = join(root, 'parent')
  initRepo(parentDir, 'main')
  writeFileSync(
    join(parentDir, '.gitmodules'),
    `[submodule "docs/internal"]\n\tpath = docs/internal\n\turl = ${subRemoteDir}\n\tbranch = ${branch}\n`
  )
  git(parentDir, 'add', '.gitmodules')
  git(parentDir, 'commit', '-q', '-m', 'init (no gitlink yet)')

  const mountDir = join(parentDir, 'docs', 'internal')
  execFileSync('git', ['clone', '-q', subRemoteDir, mountDir], { env: makeFixtureEnv() })

  return { root, subRemoteDir, seedDir, parentDir, mountDir, branch, base, T }
}

/** Register `sha` as docs/internal's gitlink in a new commit on `parentDir`. */
function commitGitlink(parentDir: string, sha: string, message: string): string {
  git(parentDir, 'update-index', '--add', '--cacheinfo', `160000,${sha},docs/internal`)
  git(parentDir, 'commit', '-q', '-m', message)
  return git(parentDir, 'rev-parse', 'HEAD')
}

/** A commit touching an unrelated file only (never touches the mount — R0/R9 fixtures). */
function commitUnrelated(parentDir: string, message = 'unrelated change'): string {
  return commitFile(parentDir, `unrelated-${Date.now()}-${Math.random()}.txt`, 'x\n', message)
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runScript(parentDir: string, args: string[]): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: parentDir,
    encoding: 'utf8',
    env: makeFixtureEnv(),
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const createdRoots: string[] = []
function track(f: Fixture): Fixture {
  createdRoots.push(f.root)
  return f
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R0-R11 + R-FETCH
// ---------------------------------------------------------------------------

describe('check-submodule-pointer.sh — R0-R11 + R-FETCH', () => {
  it('R0: diff does not touch the mount -> SKIP-PASS, exit 0', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.T, 'bump to T')
    commitUnrelated(f.parentDir)
    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIP-PASS (R0)')
  })

  it('R1: S object absent after full fetch -> FAIL, exit 1 (block mode)', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'base bump (target)')
    commitGitlink(f.parentDir, FAKE_SHA_1, 'S = never-pushed SHA')
    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R1:')
    expect(r.stdout).toContain(FAKE_SHA_1)
    expect(r.stdout).toContain('was never pushed')
  })

  it('R2: S === T -> PASS (T-axis), exit 0', () => {
    const f = track(buildFixture())
    // target registers `base` (an ancestor of T, still resolvable) as B, so
    // this exercises R2 with B genuinely available (not entangled with R10).
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, f.T, 'S = T')
    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS [docs/internal]')
    expect(r.stdout).not.toMatch(/R[3-7]:/)
  })

  it('R3: S is a strict ancestor of T -> FAIL (stale), exit 1', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'base bump (target)')
    commitGitlink(f.parentDir, f.T, 'S = T (stale once remote advances)')
    // Advance the remote AFTER the pointer was set — the script's own full
    // fetch must observe this and classify S as behind.
    commitFile(f.seedDir, 'f2.txt', 'advance\n', 'remote advances past T')
    git(f.seedDir, 'push', '-q', 'origin', f.branch)

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R3:')
    expect(r.stdout).toContain('stale')
    expect(r.stdout).toContain('by 1 commits')
  })

  it('R4: S is a strict descendant of T and lives on a live remote branch -> PASS + warning', () => {
    const f = track(buildFixture())
    git(f.seedDir, 'checkout', '-q', '-b', 'later')
    const sDesc = commitFile(f.seedDir, 'f2.txt', 'later\n', 'S: descendant of T on a live branch')
    git(f.seedDir, 'push', '-q', 'origin', 'later')

    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, sDesc, 'S = descendant of T')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS-WARN (R4)')
    expect(r.stdout).toContain('live remote branch')
    // SMI-6260 review fix: a pure R4 case (no independent B-axis R7 match)
    // must emit exactly ONE result line for the mount -- R4's own verdict is
    // "PASS + warning annotation", a single line, not that line followed by
    // a second, redundant generic "PASS: ... OK relative to ..." line for
    // the same mount. Confirmed live before the fix: both lines printed.
    const resultLines = r.stdout.split('\n').filter((line) => line.includes('[docs/internal]'))
    expect(resultLines).toHaveLength(1)
  })

  it('R5: S is a strict descendant of T but contained in no remote branch -> FAIL (orphaned)', () => {
    const f = track(buildFixture())
    git(f.seedDir, 'checkout', '-q', '-b', 'throwaway')
    const orphanSha = commitFile(f.seedDir, 'f2.txt', 'orphan\n', 'S: will be orphaned')
    git(f.seedDir, 'push', '-q', 'origin', 'throwaway')
    // Prime the mount's local object store with the SHA while the branch
    // still exists remotely — mirrors the real-world SMI-5823 scenario
    // (a pointer set when the branch was live; the branch is force-pushed
    // or deleted AFTER, but the mount's own store still has the object).
    git(f.mountDir, 'fetch', 'origin', '--prune', '--quiet')
    git(f.seedDir, 'push', '-q', 'origin', '--delete', 'throwaway')

    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, orphanSha, 'S = now-orphaned descendant')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R5:')
    expect(r.stdout).toContain('orphaned tip')
    expect(r.stdout).toContain('force-pushed or deleted')
  })

  it('R6: S is neither an ancestor nor a descendant of T -> FAIL (diverged)', () => {
    const f = track(buildFixture())
    git(f.seedDir, 'checkout', '-q', '--orphan', 'diverged-root')
    execFileSync('git', ['rm', '-rf', '--quiet', '.'], { cwd: f.seedDir, env: makeFixtureEnv() })
    const divergedSha = commitFile(
      f.seedDir,
      'fz.txt',
      'diverged\n',
      'S: unrelated root, diverged from T'
    )
    git(f.seedDir, 'push', '-q', 'origin', 'diverged-root')

    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, divergedSha, 'S = diverged commit')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R6:')
    expect(r.stdout).toContain('diverged')
  })

  it('R7: S is a strict ancestor of B -> FAIL (backward regression)', () => {
    const f = track(buildFixture())
    const bSha = commitFile(f.seedDir, 'f2.txt', 'further\n', 'B: descendant of T, still on main')
    git(f.seedDir, 'push', '-q', 'origin', f.branch)

    const c1 = commitGitlink(f.parentDir, bSha, 'B = further-than-T (target)')
    commitGitlink(f.parentDir, f.T, 'S = T (strict ancestor of B)')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R7:')
    expect(r.stdout).toContain('backward regression')
    expect(r.stdout).toContain(bSha)
  })

  it('R8: PAT unavailable and diff touches the mount -> FAIL', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, f.T, 'S = T')
    const r = runScript(f.parentDir, [
      '--mode=block',
      '--ref=HEAD',
      `--target=${c1}`,
      '--pat-available=false',
    ])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R8:')
    expect(r.stdout).toContain('external contributors cannot bump')
  })

  it('R9: PAT unavailable and diff does not touch the mount -> SKIP-PASS', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.T, 'bump to T')
    commitUnrelated(f.parentDir)
    const r = runScript(f.parentDir, [
      '--mode=block',
      '--ref=HEAD',
      `--target=${c1}`,
      '--pat-available=false',
    ])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIP-PASS (R9)')
  })

  it('R10: B absent from the tree entirely -> R7 not evaluated, T-axis still resolves', () => {
    const f = track(buildFixture())
    // The `init` commit inside buildFixture() has NO gitlink entry at all —
    // use it directly as the diff base so B is genuinely absent, not merely
    // unresolvable (that's R11).
    const initCommit = git(f.parentDir, 'rev-parse', 'HEAD')
    commitGitlink(f.parentDir, f.T, 'first-ever registration of docs/internal')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${initCommit}`])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS [docs/internal]')
    expect(r.stdout).not.toContain('R7:')
    expect(r.stdout).not.toContain('R11:')
  })

  it('R11: B present in the tree but unresolvable -> FAIL, distinct "not caused by this PR" message', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, FAKE_SHA_2, 'B = dangling/never-pushed SHA')
    commitGitlink(f.parentDir, f.T, 'S = T (real, resolvable)')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R11:')
    expect(r.stdout).toContain(FAKE_SHA_2)
    expect(r.stdout).toContain('predates this PR/push and was not caused by it')
    expect(r.stdout).toContain('ADR-143')
  })

  it('R-FETCH: the fetch itself fails -> distinct infra message, not R1/R11; retries once in block mode', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, f.T, 'S = T')
    // Point the mount's own remote at a nonexistent path so every fetch
    // attempt fails — simulates a network/auth failure, not a content
    // problem with S or B.
    git(f.mountDir, 'remote', 'set-url', 'origin', '/nonexistent/path/does-not-exist.git')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R-FETCH:')
    expect(r.stdout).toContain('infra: fetch failed, not a content problem')
    expect(r.stdout).not.toContain('R1:')
    expect(r.stdout).not.toContain('R11:')
  })
})

// ---------------------------------------------------------------------------
// Evaluation-order / combination semantics, precondition gating, mode
// behavior, --before honoring, and the PR #2609 regression replay.
// ---------------------------------------------------------------------------

describe('check-submodule-pointer.sh — evaluation order, gating, and mode semantics', () => {
  it('combined state T < S < B: R4 (T-axis PASS) does not mask R7 (B-axis FAIL) — overall FAIL', () => {
    const f = track(buildFixture())
    git(f.seedDir, 'checkout', '-q', '-b', 'later')
    const sSha = commitFile(f.seedDir, 'f2.txt', 'later\n', 'S: descendant of T, on live branch')
    git(f.seedDir, 'push', '-q', 'origin', 'later')
    const bSha = commitFile(
      f.seedDir,
      'f3.txt',
      'even-later\n',
      'B: further descendant, still live'
    )
    git(f.seedDir, 'push', '-q', 'origin', 'later')

    const c1 = commitGitlink(f.parentDir, bSha, 'B = further descendant (target)')
    commitGitlink(f.parentDir, sSha, 'S = descendant of T, ancestor of B')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    // A naive first-match implementation would stop at R4's PASS. The
    // binding evaluation-order semantics require the overall verdict to be
    // FAIL because R7 also independently matches.
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('PASS-WARN (R4)')
    expect(r.stdout).toContain('R7:')
    expect(r.stdout).toContain('backward regression')
  })

  it('dedicated evaluation-order case: R2 (T-axis PASS, S===T) does not mask R7 (B-axis FAIL) — overall FAIL', () => {
    const f = track(buildFixture())
    git(f.seedDir, 'checkout', '-q', '-b', 'future')
    const bSha = commitFile(
      f.seedDir,
      'f2.txt',
      'future\n',
      'B: child of T, on a separate branch (main stays at T)'
    )
    git(f.seedDir, 'push', '-q', 'origin', 'future')

    const c1 = commitGitlink(f.parentDir, bSha, 'B = future (target)')
    commitGitlink(f.parentDir, f.T, 'S = T (===fetched tip; R2 on the T-axis)')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    // R2 (S===T) is a silent pass on the T-axis — unlike R4, it has no
    // message of its own, so the mount's single-line verdict is driven
    // entirely by R7's FAIL. The key assertion is that R2 being satisfied
    // does NOT suppress R7 (a naive first-match implementation would never
    // reach the B-axis check at all once the T-axis matched R2).
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('PASS-WARN')
    expect(r.stdout).toContain('FAIL [docs/internal]')
    expect(r.stdout).toContain('R7:')
  })

  it('precondition gating: R1 present short-circuits Layer 2 — no R2-R7 comparison attempted, no crash', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, FAKE_SHA_1, 'S = never-pushed SHA')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R1:')
    expect(r.stdout).not.toMatch(/R[2-7]:/)
    expect(r.stderr).not.toMatch(/unbound variable|command not found|syntax error/i)
  })

  it('precondition gating: R11 present short-circuits Layer 2 even though S alone would resolve cleanly', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, FAKE_SHA_2, 'B = dangling SHA')
    commitGitlink(f.parentDir, f.T, 'S = T (would otherwise cleanly PASS R2)')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R11:')
    expect(r.stdout).not.toMatch(/R[2-7]:/)
    expect(r.stdout).not.toContain('PASS')
    expect(r.stderr).not.toMatch(/unbound variable|command not found|syntax error/i)
  })

  it('--mode=warn prints the same FAIL verdict as --mode=block but always exits 0', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(f.parentDir, f.T, 'S = T (stale once remote advances)')
    commitFile(f.seedDir, 'f2.txt', 'advance\n', 'remote advances past T')
    git(f.seedDir, 'push', '-q', 'origin', f.branch)

    const warnResult = runScript(f.parentDir, ['--mode=warn', '--ref=HEAD', `--target=${c1}`])
    expect(warnResult.status).toBe(0)
    expect(warnResult.stdout).toContain('R3:')

    const blockResult = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(blockResult.status).toBe(1)
    expect(blockResult.stdout).toContain('R3:')
  })

  it('BLOCKING_MOUNTS gating: a FAIL on a non-blocking mount is downgraded to WARN and never blocks --mode=block', () => {
    const f = track(buildFixture())
    // Second mount, not docs/internal — must be warn-only even under
    // --mode=block per the plan's v1 scope-boundary decision.
    const strategyRemote = join(f.root, 'strategy-remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'skills', strategyRemote], {
      env: makeFixtureEnv(),
    })
    const strategySeed = join(f.root, 'strategy-seed')
    initRepo(strategySeed, 'skills')
    commitFile(strategySeed, 'g.txt', 'g\n', 'strategy seed commit')
    git(strategySeed, 'remote', 'add', 'origin', strategyRemote)
    git(strategySeed, 'push', '-q', 'origin', 'skills')

    // Register the second mount in .gitmodules and give it an unresolvable
    // (R1-triggering) gitlink — a real FAIL, but on a non-blocking mount.
    const gitmodulesPath = join(f.parentDir, '.gitmodules')
    const existing = execFileSync('cat', [gitmodulesPath], { encoding: 'utf8' })
    writeFileSync(
      gitmodulesPath,
      `${existing}\n[submodule ".claude/skills"]\n\tpath = .claude/skills\n\turl = ${strategyRemote}\n\tbranch = skills\n`
    )
    git(f.parentDir, 'add', '.gitmodules')
    execFileSync('git', ['clone', '-q', strategyRemote, join(f.parentDir, '.claude', 'skills')], {
      env: makeFixtureEnv(),
    })
    git(f.parentDir, 'add', '.claude/skills')
    git(f.parentDir, 'commit', '-q', '-m', 'add strategy mount')
    const c1 = commitGitlink(f.parentDir, f.base, 'B(docs/internal) = base (target)')

    // Bump docs/internal cleanly (S===T) AND the strategy mount to an
    // unresolvable SHA (R1) in the same commit.
    git(f.parentDir, 'update-index', '--add', '--cacheinfo', `160000,${f.T},docs/internal`)
    git(f.parentDir, 'update-index', '--add', '--cacheinfo', `160000,${FAKE_SHA_1},.claude/skills`)
    git(f.parentDir, 'commit', '-q', '-m', 'docs/internal clean, .claude/skills R1')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('WARN (non-blocking mount) [.claude/skills]')
    expect(r.stdout).toContain('R1:')
    expect(r.stdout).not.toContain('FAIL [.claude/skills]')
  })

  it('not-initialized local checkout is skipped gracefully, never blocks (advisory even under --mode=block)', () => {
    const f = track(buildFixture())
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    rmSync(f.mountDir, { recursive: true, force: true })
    mkdirSync(f.mountDir, { recursive: true })
    git(f.parentDir, 'update-index', '--add', '--cacheinfo', `160000,${f.T},docs/internal`)
    git(f.parentDir, 'commit', '-q', '-m', 'bump while mount uninitialized on disk')

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIP [docs/internal]')
    expect(r.stdout).toContain('not initialized')
  })

  it('--before overrides --target as the source of B (post-merge B_prev reconstruction, Wave 2 usage)', () => {
    const f = track(buildFixture())
    // --target points at a commit registering an UNRESOLVABLE B (would
    // trigger R11 if used) — --before must win instead, pointing at a
    // commit registering a valid, resolvable B.
    const wrongTarget = commitGitlink(f.parentDir, FAKE_SHA_2, 'wrong target: unresolvable B')
    const rightBefore = commitGitlink(f.parentDir, f.base, 'right before: resolvable B = base')
    commitGitlink(f.parentDir, f.T, 'S = T (descendant of base, so R7 does not fire either)')

    const r = runScript(f.parentDir, [
      '--mode=block',
      '--ref=HEAD',
      `--target=${wrongTarget}`,
      `--before=${rightBefore}`,
    ])
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('R11:')
    expect(r.stdout).toContain('PASS [docs/internal]')
  })

  // Regression test for the confirmed root-cause incident (PR #2609,
  // SMI-6205 Wave 4): the squash commit 21ec0139c moved the docs/internal
  // gitlink e89c8fd -> 928fc96e7, a forward bump relative to the PR
  // branch's own prior pointer — parent-side history looked clean. But
  // 928fc96 ("SMI-6205 PR #2609 pre-merge review report") is a strict
  // ancestor of cadbd29 ("SMI-6205 PR #2609 post-merge governance retro"),
  // which had ALREADY landed on docs/internal's own origin/main before
  // #2609 merged — the merge silently regressed the registered pointer
  // backward relative to docs/internal's own mainline (an R3 case: S stale
  // relative to T). Replaying the literal real SHAs isn't practical in an
  // isolated fixture (they're private-submodule commits, unreachable from
  // a throwaway bare repo) — this fixture mirrors the exact same shape
  // (S ahead-looking-but-actually-behind-T) with synthetic commits instead.
  it('PR #2609 regression replay (synthetic 928fc96/cadbd29-shaped fixture) -> R3-FAIL', () => {
    const f = track(buildFixture())
    // S: the "pre-merge review report"-equivalent commit (928fc96).
    const preMergeReportSha = f.T
    const c1 = commitGitlink(f.parentDir, f.base, 'B = base (target)')
    commitGitlink(
      f.parentDir,
      preMergeReportSha,
      'gitlink bump: e89c8fd-equivalent -> 928fc96-equivalent'
    )
    // T advances past S: the "post-merge governance retro"-equivalent
    // commit (cadbd29) lands on docs/internal's own origin/main before the
    // parent-repo PR merges.
    commitFile(f.seedDir, 'retro.txt', 'retro\n', 'cadbd29-equivalent: post-merge governance retro')
    git(f.seedDir, 'push', '-q', 'origin', f.branch)

    const r = runScript(f.parentDir, ['--mode=block', '--ref=HEAD', `--target=${c1}`])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('R3:')
    expect(r.stdout).toContain('stale')
  })
})
