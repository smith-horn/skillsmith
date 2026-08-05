/**
 * Multi-submodule regression for rebase-worktree.sh (SMI-4829, Wave 2A).
 *
 * Verifies the script handles N submodules independently after the
 * SUBMODULES=() parameterization (replacing 12 hardcoded `docs/internal`
 * references). Uses two real bare submodule repos so the script's
 * cross-fetch / directional-guard / pointer-update / report paths all
 * exercise both submodules.
 *
 * Mirrors the fixture style of rebase-worktree.test.ts (bare remotes +
 * git worktree + makeFixtureEnv). All temp dirs are cleaned afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const SCRIPT_PATH = join(__dirname, '..', 'rebase-worktree.sh')
const GIT_ENV = makeFixtureEnv()

function makeTempDir(prefix: string): string {
  return makeFixtureTempDir(prefix)
}

function git(cwd: string, args: string): string {
  return execSync(`git -c init.defaultBranch=main -c protocol.file.allow=always ${args}`, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

function sh(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: 'utf8', env: GIT_ENV, ...opts }).trim()
}

function runScript(args: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash "${SCRIPT_PATH}" ${args}`, {
      encoding: 'utf8',
      timeout: 30_000,
      // SMI-5702: this file's fixtures never register a git-crypt filter at
      // all (MISSING to the new classifier) and this suite is entirely
      // about submodule cross-fetch/directional-guard behavior — disabling
      // the new Step 6.5 heal keeps it scoped to that, same rationale as
      // rebase-worktree.helpers.ts's runScript().
      env: { ...GIT_ENV, SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE: '1' },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/**
 * Build a parent repo with two submodules A and B (both pointed at separate
 * bare repos), create a worktree from a feature branch, and initialize both
 * submodules in the worktree.
 *
 * Returns paths plus initial submodule SHAs the worktree currently points at.
 */
function setupTwoSubmoduleWorktree(tempRoot: string): {
  bareDir: string
  cloneDir: string
  worktreeDir: string
  subABare: string
  subBBare: string
  initialA: string
  initialB: string
} {
  const bareDir = join(tempRoot, 'bare.git')
  const subABare = join(tempRoot, 'subA-bare.git')
  const subBBare = join(tempRoot, 'subB-bare.git')
  const cloneDir = join(tempRoot, 'clone')
  const worktreeDir = join(tempRoot, 'wt')

  git(tempRoot, `init --bare "${bareDir}"`)
  git(tempRoot, `init --bare "${subABare}"`)
  git(tempRoot, `init --bare "${subBBare}"`)

  // Seed submodule A
  const subASeed = join(tempRoot, 'subA-seed')
  git(tempRoot, `clone "${subABare}" "${subASeed}"`)
  sh(`touch "${join(subASeed, 'a.md')}"`)
  git(subASeed, 'add a.md')
  git(subASeed, 'commit -m "subA initial"')
  git(subASeed, 'push origin main')

  // Seed submodule B
  const subBSeed = join(tempRoot, 'subB-seed')
  git(tempRoot, `clone "${subBBare}" "${subBSeed}"`)
  sh(`touch "${join(subBSeed, 'b.md')}"`)
  git(subBSeed, 'add b.md')
  git(subBSeed, 'commit -m "subB initial"')
  git(subBSeed, 'push origin main')

  // Parent clone with both submodules
  git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
  sh(`touch "${join(cloneDir, 'README.md')}"`)
  git(cloneDir, 'add README.md')
  git(cloneDir, 'commit -m "initial"')
  git(cloneDir, `submodule add "${subABare}" docs/internal`)
  git(cloneDir, `submodule add "${subBBare}" .claude/skills`)
  git(cloneDir, 'commit -m "add two submodules"')
  git(cloneDir, 'push origin main')

  // Worktree on a feature branch with both submodules initialized
  git(cloneDir, `worktree add -b feature "${worktreeDir}"`)
  git(worktreeDir, 'submodule update --init')

  const initialA = git(join(worktreeDir, 'docs', 'internal'), 'rev-parse HEAD')
  const initialB = git(join(worktreeDir, '.claude', 'skills'), 'rev-parse HEAD')

  return { bareDir, cloneDir, worktreeDir, subABare, subBBare, initialA, initialB }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  tempDirs.length = 0
})

describe('SMI-4829: rebase-worktree.sh multi-submodule', () => {
  // Gate #1 primary scenario: two submodules diverge in different directions
  // — A is BEHIND target (target advanced; worktree at older SHA), B is
  // AHEAD of target (worktree advanced beyond target). Without
  // --allow-submodule-ahead, the script must surface B's AHEAD divergence
  // and exit 1 (refusing to silently rebase past it).
  it('detects divergence in two submodules independently', () => {
    const tempRoot = makeTempDir('rw-multi-1')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir, subABare } = setupTwoSubmoduleWorktree(tempRoot)

    // Advance submodule A on origin (parent will see new pointer); worktree
    // stays at the old A SHA → A is BEHIND target.
    const subAClone = join(tempRoot, 'subA-advance')
    git(tempRoot, `clone "${subABare}" "${subAClone}"`)
    sh(`echo a-advance > "${join(subAClone, 'a-new.md')}"`)
    git(subAClone, 'add a-new.md')
    git(subAClone, 'commit -m "subA advance on main"')
    git(subAClone, 'push origin main')
    git(cloneDir, 'checkout main')
    git(cloneDir, 'submodule update --remote docs/internal')
    git(cloneDir, 'add docs/internal')
    git(cloneDir, 'commit -m "bump subA on main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    // Advance submodule B in the WORKTREE only — B is AHEAD of target.
    const wtSubB = join(worktreeDir, '.claude', 'skills')
    sh(`echo b-ahead > "${join(wtSubB, 'b-ahead.md')}"`)
    git(wtSubB, 'add b-ahead.md')
    git(wtSubB, 'commit -m "subB ahead in worktree"')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('AHEAD')
    expect(combined).toContain('.claude/skills')
  })

  // SMI-4829 scoped allow: --allow-submodule-ahead=<path> permits ONLY the
  // named submodule to be ahead. A second submodule that's also ahead must
  // still trigger the error.
  it('scoped --allow-submodule-ahead=<path> only permits the named submodule', () => {
    const tempRoot = makeTempDir('rw-multi-2')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupTwoSubmoduleWorktree(tempRoot)

    // Advance both submodules in the worktree (both BECOME strict
    // descendants of the target's pointer).
    const wtSubA = join(worktreeDir, 'docs', 'internal')
    const wtSubB = join(worktreeDir, '.claude', 'skills')
    sh(`echo a-ahead > "${join(wtSubA, 'a-ahead.md')}"`)
    git(wtSubA, 'add a-ahead.md')
    git(wtSubA, 'commit -m "subA ahead in worktree"')
    sh(`echo b-ahead > "${join(wtSubB, 'b-ahead.md')}"`)
    git(wtSubB, 'add b-ahead.md')
    git(wtSubB, 'commit -m "subB ahead in worktree"')

    // Advance parent main so a rebase is needed.
    git(cloneDir, 'checkout main')
    sh(`echo parent > "${join(cloneDir, 'parent.txt')}"`)
    git(cloneDir, 'add parent.txt')
    git(cloneDir, 'commit -m "parent advance"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--allow-submodule-ahead=docs/internal "${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    // The unnamed submodule still errors as AHEAD.
    expect(combined).toContain('AHEAD')
    expect(combined).toContain('.claude/skills')
  })

  // Gate #1 + SMI-4773: scoped allow passes the named submodule and rebases
  // cleanly when the OTHER submodule is at-target (not divergent).
  it('rebases successfully with scoped allow when only the named submodule is ahead', () => {
    const tempRoot = makeTempDir('rw-multi-3')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupTwoSubmoduleWorktree(tempRoot)

    // Worktree A advances (strict descendant); B unchanged.
    const wtSubA = join(worktreeDir, 'docs', 'internal')
    sh(`echo a-ahead > "${join(wtSubA, 'a-ahead.md')}"`)
    git(wtSubA, 'add a-ahead.md')
    git(wtSubA, 'commit -m "subA ahead in worktree"')
    const wtSubASha = git(wtSubA, 'rev-parse HEAD')

    // Parent advances on main (no submodule change there).
    git(cloneDir, 'checkout main')
    sh(`echo parent > "${join(cloneDir, 'parent.txt')}"`)
    git(cloneDir, 'add parent.txt')
    git(cloneDir, 'commit -m "parent advance"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--allow-submodule-ahead=docs/internal "${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('strict descendant')
    // Worktree A's pointer must be unchanged (still the descendant).
    expect(git(wtSubA, 'rev-parse HEAD')).toBe(wtSubASha)
  })

  // SMI-4829 cross-fetch coverage: when both submodules need fetching the
  // step 5 banner fires once and the success line shows. Catches a regression
  // where the iteration only reports for the FIRST submodule.
  it('cross-fetches submodule objects for every initialized submodule', () => {
    const tempRoot = makeTempDir('rw-multi-4')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupTwoSubmoduleWorktree(tempRoot)

    // Force a parent advance so the script proceeds past the
    // up-to-date fast-path into step 5.
    git(cloneDir, 'checkout main')
    sh(`echo parent > "${join(cloneDir, 'parent.txt')}"`)
    git(cloneDir, 'add parent.txt')
    git(cloneDir, 'commit -m "parent advance"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`--dry-run "${worktreeDir}"`)
    expect(result.status).toBe(0)
    // Both submodule paths appear in step 2's record-state output…
    expect(result.stdout).toContain('Submodule (docs/internal)')
    expect(result.stdout).toContain('Submodule (.claude/skills)')
    // …and step 5 (cross-fetch) reports BOTH dry-run lines.
    expect(result.stdout).toContain('Would cross-fetch')
    expect(result.stdout.match(/Would cross-fetch/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  // SMI-4829 / Gate #1: with .gitmodules absent (defensive fallback) the
  // script must NOT error — it should report "no submodules declared" and
  // proceed normally. Pre-cutover repos without .gitmodules still need to
  // rebase cleanly.
  it('proceeds with no submodules when .gitmodules is absent', () => {
    const tempRoot = makeTempDir('rw-multi-5')
    tempDirs.push(tempRoot)

    const bareDir = join(tempRoot, 'bare.git')
    const cloneDir = join(tempRoot, 'clone')
    const worktreeDir = join(tempRoot, 'wt')
    git(tempRoot, `init --bare "${bareDir}"`)
    git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
    sh(`touch "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "initial"')
    git(cloneDir, 'push origin main')
    git(cloneDir, `worktree add -b feature "${worktreeDir}"`)

    git(cloneDir, 'checkout main')
    sh(`echo "advance" > "${join(cloneDir, 'a.txt')}"`)
    git(cloneDir, 'add a.txt')
    git(cloneDir, 'commit -m "advance"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    // Sanity: ensure no .gitmodules exists in the worktree.
    expect(existsSync(join(worktreeDir, '.gitmodules'))).toBe(false)

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Submodules: none declared in .gitmodules')
    expect(result.stdout).toContain('Rebase complete')
  })

  // SMI-4829: enumerate_submodules should fail-soft if .gitmodules contains
  // unparseable content (the script must not crash; it should treat as "no
  // submodules" and continue).
  it('treats malformed .gitmodules as no submodules (fail-soft)', () => {
    const tempRoot = makeTempDir('rw-multi-6')
    tempDirs.push(tempRoot)

    const bareDir = join(tempRoot, 'bare.git')
    const cloneDir = join(tempRoot, 'clone')
    const worktreeDir = join(tempRoot, 'wt')
    git(tempRoot, `init --bare "${bareDir}"`)
    git(tempRoot, `clone "${bareDir}" "${cloneDir}"`)
    sh(`touch "${join(cloneDir, 'README.md')}"`)
    git(cloneDir, 'add README.md')
    git(cloneDir, 'commit -m "initial"')
    // Drop a malformed .gitmodules (no submodule.<name>.path entries).
    writeFileSync(join(cloneDir, '.gitmodules'), '# malformed — no submodule sections\n', 'utf8')
    git(cloneDir, 'add .gitmodules')
    git(cloneDir, 'commit -m "junk gitmodules"')
    git(cloneDir, 'push origin main')
    git(cloneDir, `worktree add -b feature "${worktreeDir}"`)

    git(cloneDir, 'checkout main')
    sh(`echo "advance" > "${join(cloneDir, 'a.txt')}"`)
    git(cloneDir, 'add a.txt')
    git(cloneDir, 'commit -m "advance"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Submodules: none declared in .gitmodules')
  })

  // SMI-5823: reproduces the actual false-divergence bug — main checkout's
  // own submodule copy is stale (lacks the object the parent's tree now
  // declares), but the submodule's real origin has it. Before the fix,
  // Step 5 only ever fetched from the stale main-copy, so Step 8's ancestry
  // check couldn't find a common ancestor and reported a hard "diverged"
  // error even though this is a plain fast-forward.
  it('succeeds when main checkout submodule copy is stale but origin has the target object', () => {
    const tempRoot = makeTempDir('rw-multi-7')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir, subABare } = setupTwoSubmoduleWorktree(tempRoot)

    // Advance submodule A on its real origin via an independent clone —
    // simulating a different session having pushed this commit.
    const subAClone = join(tempRoot, 'subA-advance')
    git(tempRoot, `clone "${subABare}" "${subAClone}"`)
    sh(`echo a-advance > "${join(subAClone, 'a-new.md')}"`)
    git(subAClone, 'add a-new.md')
    git(subAClone, 'commit -m "subA advance on origin"')
    git(subAClone, 'push origin main')
    const newASha = git(subAClone, 'rev-parse HEAD')

    // Bump the parent's gitlink via --cacheinfo directly (gitlinks are
    // never dereferenced by git, so this is valid without the object being
    // present locally), WITHOUT running `submodule update` in cloneDir —
    // its own submodule copy stays at the old SHA and never fetches the
    // new commit. This reproduces the staleness precondition exactly.
    git(cloneDir, 'checkout main')
    git(cloneDir, `update-index --cacheinfo 160000,${newASha},docs/internal`)
    git(cloneDir, 'commit -m "bump subA on main (cacheinfo only, no local checkout)"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    // Sanity: cloneDir's own submodule copy genuinely lacks the new object.
    expect(() =>
      git(join(cloneDir, 'docs', 'internal'), `cat-file -e ${newASha}^{commit}`)
    ).toThrow()

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')
    const wtSubA = join(worktreeDir, 'docs', 'internal')
    expect(git(wtSubA, 'rev-parse HEAD')).toBe(newASha)
  })

  // SMI-5823: reproduces the control-flow trap — main checkout has NO local
  // submodule copy at all (deinit'd/never initialized). Before the fix, the
  // "main repo submodule not found" branch `continue`d past any fetch
  // attempt whatsoever, so origin was never tried either.
  it('succeeds via origin when the main checkout has no local submodule copy at all', () => {
    const tempRoot = makeTempDir('rw-multi-8')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir, subABare } = setupTwoSubmoduleWorktree(tempRoot)

    const subAClone = join(tempRoot, 'subA-advance')
    git(tempRoot, `clone "${subABare}" "${subAClone}"`)
    sh(`echo a-advance > "${join(subAClone, 'a-new.md')}"`)
    git(subAClone, 'add a-new.md')
    git(subAClone, 'commit -m "subA advance on origin"')
    git(subAClone, 'push origin main')
    const newASha = git(subAClone, 'rev-parse HEAD')

    git(cloneDir, 'checkout main')
    git(cloneDir, `update-index --cacheinfo 160000,${newASha},docs/internal`)
    git(cloneDir, 'commit -m "bump subA on main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'submodule deinit -f docs/internal')
    git(cloneDir, 'checkout -')

    expect(existsSync(join(cloneDir, 'docs', 'internal', '.git'))).toBe(false)

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Rebase complete')
    const wtSubA = join(worktreeDir, 'docs', 'internal')
    expect(git(wtSubA, 'rev-parse HEAD')).toBe(newASha)
  })

  // SMI-5823 regression guard: with BOTH submodule objects genuinely
  // present and fetchable (real divergence, not a missing-object gap), the
  // script must still report divergence — proves the new object-presence
  // check doesn't swallow a real conflict into a misleading diagnostic.
  it('still reports genuine divergence when both submodule objects are present', () => {
    const tempRoot = makeTempDir('rw-multi-9')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir, subABare } = setupTwoSubmoduleWorktree(tempRoot)

    const subAClone = join(tempRoot, 'subA-advance')
    git(tempRoot, `clone "${subABare}" "${subAClone}"`)
    sh(`echo a-on-origin > "${join(subAClone, 'a-origin.md')}"`)
    git(subAClone, 'add a-origin.md')
    git(subAClone, 'commit -m "subA advance on origin"')
    git(subAClone, 'push origin main')
    git(cloneDir, 'checkout main')
    git(cloneDir, 'submodule update --remote docs/internal')
    git(cloneDir, 'add docs/internal')
    git(cloneDir, 'commit -m "bump subA on main"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    // Independently advance the WORKTREE's submodule with a real, fetchable
    // commit that exists only there — neither side is an ancestor of the
    // other.
    const wtSubA = join(worktreeDir, 'docs', 'internal')
    sh(`echo a-in-worktree > "${join(wtSubA, 'a-worktree.md')}"`)
    git(wtSubA, 'add a-worktree.md')
    git(wtSubA, 'commit -m "subA diverges in worktree"')

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('diverged')
    expect(combined).not.toContain('could not verify ancestry')
  })

  // SMI-5823: if neither the main checkout's local copy nor origin can
  // supply the target object, Step 8 must report object unavailability
  // instead of misclassifying the unverifiable history as divergence.
  it('reports unavailable objects when origin cannot supply the target commit', () => {
    const tempRoot = makeTempDir('rw-multi-10')
    tempDirs.push(tempRoot)
    const { cloneDir, worktreeDir } = setupTwoSubmoduleWorktree(tempRoot)
    const missingSha = '1111111111111111111111111111111111111111'

    // A gitlink can record an object the parent repository does not have.
    // Point main at such an object, then make the worktree submodule's
    // origin unavailable so both Step 5 fetch sources fail.
    git(cloneDir, 'checkout main')
    git(cloneDir, `update-index --cacheinfo 160000,${missingSha},docs/internal`)
    git(cloneDir, 'commit -m "point subA at unavailable object"')
    git(cloneDir, 'push origin main')
    git(cloneDir, 'checkout -')

    const wtSubA = join(worktreeDir, 'docs', 'internal')
    git(wtSubA, `remote set-url origin "${join(tempRoot, 'missing-origin.git')}"`)

    const result = runScript(`"${worktreeDir}"`)
    expect(result.status).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toContain('could not verify ancestry')
    expect(combined).toContain('commit objects are unavailable locally')
    expect(combined).not.toContain('has diverged from target')
  })
})
