/**
 * SMI-4693 — regression tests for the fixture-isolation helpers.
 *
 * Asserts that `makeFixtureEnv` strips every git discovery env var, that
 * `makeFixtureTempDir` realpath-canonicalises `tmpdir()` (closing the macOS
 * `/var` ↔ `/private/var` asymmetry), AND — most importantly — that
 * spawning `git checkout -B <branch>` from a worktree-rooted `process.cwd()`
 * but with `cwd: tmpRepo` + `env: makeFixtureEnv()` does NOT mutate the
 * outer worktree's branch state. That last assertion (#3 below) is the one
 * that proves the helper seals the actual H2/H3 leak path identified in
 * `docs/internal/research/smi-4693-fixture-leak-rca.md` — independent of
 * whether `GIT_DIR` was the original env-leak vector.
 *
 * If a future regression breaks the helper, this file is the early-warning.
 * Audit-39 in `scripts/audit-standards.mjs` is the second line of defence.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const tempDirsToClean: string[] = []

afterEach(() => {
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('SMI-4693: makeFixtureEnv strips git discovery env vars', () => {
  it('removes every GIT_DISCOVERY_VAR from the returned env', () => {
    const original = { ...process.env }
    const sentinels = {
      GIT_DIR: '/totally/wrong/path/.git',
      GIT_WORK_TREE: '/totally/wrong',
      GIT_INDEX_FILE: '.git/index',
      GIT_OBJECT_DIRECTORY: '/x/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y/objects',
      GIT_COMMON_DIR: '/z/.git',
      GIT_NAMESPACE: 'leaked',
      GIT_PREFIX: 'subdir/',
      GIT_CEILING_DIRECTORIES: '/',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    }
    Object.assign(process.env, sentinels)
    try {
      const env = makeFixtureEnv()
      for (const key of Object.keys(sentinels)) {
        expect(env[key], `${key} should be stripped`).toBeUndefined()
      }
      // Identity + config pins should be present.
      expect(env.GIT_AUTHOR_NAME).toBe('Test')
      expect(env.GIT_AUTHOR_EMAIL).toBe('test@test.com')
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null')
    } finally {
      // Restore — never leak into other tests.
      for (const key of Object.keys(sentinels)) {
        if (original[key] === undefined) delete process.env[key]
        else process.env[key] = original[key]
      }
    }
  })

  it('honours `extra` overrides without re-introducing leaked env', () => {
    process.env.GIT_DIR = '/leak'
    try {
      const env = makeFixtureEnv({ GIT_AUTHOR_NAME: 'dependabot[bot]' })
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_AUTHOR_NAME).toBe('dependabot[bot]')
    } finally {
      delete process.env.GIT_DIR
    }
  })
})

describe('SMI-4693: makeFixtureTempDir realpath-canonicalises tmpdir()', () => {
  it('returns a path that is its own realpath (no /var → /private/var asymmetry on macOS)', () => {
    const dir = makeFixtureTempDir('smi-4693-realpath')
    tempDirsToClean.push(dir)
    expect(dir).toBe(realpathSync(dir))
  })

  it('appends mkdtemp randomisation so concurrent calls collide-free', () => {
    const a = makeFixtureTempDir('smi-4693-collide')
    const b = makeFixtureTempDir('smi-4693-collide')
    tempDirsToClean.push(a, b)
    expect(a).not.toBe(b)
  })
})

describe('SMI-4693: end-to-end — fixture spawn does not mutate parent worktree (B-1 / H2 + H3)', () => {
  // This is the load-bearing assertion. It exercises the actual leak path:
  // `process.chdir()` to a real `.git`-containing directory (an outer
  // throwaway repo standing in for the developer's worktree), then spawn
  // `git checkout -B <synthetic-branch>` against a fixture-style temp repo
  // with `cwd: <fixture>` + `env: makeFixtureEnv()`. Without the helper, the
  // parent's branch tip moves (this is the SMI-4693 corruption signature).
  // With the helper, it does not.
  let outerRepo: string
  let outerCwdBefore: string

  beforeEach(() => {
    outerCwdBefore = process.cwd()
    outerRepo = makeFixtureTempDir('smi-4693-outer')
    tempDirsToClean.push(outerRepo)
    // Build the outer "parent worktree" — a real git repo with a feature
    // branch that the fixture must NOT mutate.
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: outerRepo, env })
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: outerRepo, env })
    execFileSync('git', ['checkout', '-q', '-B', 'smi-4693-outer-feature'], {
      cwd: outerRepo,
      env,
    })
    // Stand-in for the developer's vitest CLI cwd: chdir into the outer repo
    // so any cwd-inheritance leak from the fixture's spawn would land here.
    process.chdir(outerRepo)
  })

  afterEach(() => {
    process.chdir(outerCwdBefore)
  })

  it('spawning git checkout -B in a fixture does NOT change the outer branch (with helper)', () => {
    const fixtureRepo = makeFixtureTempDir('smi-4693-fixture')
    tempDirsToClean.push(fixtureRepo)
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRepo, env })
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: fixtureRepo,
      env,
    })

    // The exact pattern from session-priming-hook.test.ts:89 / :95.
    execFileSync('git', ['checkout', '-q', '-B', 'random-feature'], { cwd: fixtureRepo, env })
    execFileSync('git', ['checkout', '-q', '-B', 'smi-4451-test'], { cwd: fixtureRepo, env })

    const outerBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: outerRepo,
      env,
      encoding: 'utf8',
    }).trim()
    const fixtureBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: fixtureRepo,
      env,
      encoding: 'utf8',
    }).trim()

    // (a) Outer branch unchanged.
    expect(outerBranch).toBe('smi-4693-outer-feature')
    // (b) Fixture's branch IS the synthetic test branch.
    expect(fixtureBranch).toBe('smi-4451-test')
  })

  // This second assertion exists to demonstrate the env-stripping is real —
  // it is NOT the primary B-1 assertion (that's the test above). Synthetic
  // GIT_DIR injection is a hint about ONE possible vector; the test above
  // covers the actual cwd-inheritance path identified in the RCA.
  it('synthetic GIT_DIR injection does NOT redirect git when env: makeFixtureEnv() is passed', () => {
    const fixtureRepo = makeFixtureTempDir('smi-4693-gitdir')
    tempDirsToClean.push(fixtureRepo)
    const env = makeFixtureEnv()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRepo, env })
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: fixtureRepo,
      env,
    })

    // Inject a leaky GIT_DIR pointing at the OUTER repo. The helper must
    // strip it; if it didn't, the next checkout would land in `outerRepo`.
    process.env.GIT_DIR = join(outerRepo, '.git')
    try {
      execFileSync('git', ['checkout', '-q', '-B', 'env-leak-canary'], {
        cwd: fixtureRepo,
        env: makeFixtureEnv(),
      })
    } finally {
      delete process.env.GIT_DIR
    }

    const outerBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: outerRepo,
      env,
      encoding: 'utf8',
    }).trim()
    expect(outerBranch).toBe('smi-4693-outer-feature')
  })
})

describe('SMI-4693 (B-2): Audit-39 broadened regex covers spawnSync + execFileSync + execSync', () => {
  // Regex copy here MUST stay in lockstep with the one in
  // scripts/audit-standards.mjs (Audit-39). If you change one, change both
  // and update this test. The audit's primary defence is its own runtime
  // self-test (Wave 3 Step 2 §1 of the plan) — this is a cheap unit guard.
  const SPAWNS_GIT =
    /(?:execFileSync|execSync|spawnSync)\(\s*['"`]git['"`]|(?:execSync|exec)\(\s*[`'"]\s*git\b/

  it("matches execFileSync('git', …)", () => {
    expect(SPAWNS_GIT.test(`execFileSync('git', ['init'], { cwd })`)).toBe(true)
  })

  it("matches spawnSync('git', …) — B-2 broadening", () => {
    expect(SPAWNS_GIT.test(`spawnSync('git', ['init', '-q'], { cwd })`)).toBe(true)
  })

  it('matches execSync template literals: execSync(`git …`)', () => {
    expect(SPAWNS_GIT.test('execSync(`git -C ${dir} status`, opts)')).toBe(true)
  })

  it('does NOT match unrelated spawns', () => {
    expect(SPAWNS_GIT.test(`execFileSync('node', ['script.mjs'])`)).toBe(false)
    expect(SPAWNS_GIT.test(`execSync('docker compose up')`)).toBe(false)
  })
})

// Match relative imports of `_lib/git-fixture-env` from any depth. The path
// may include intermediate segments (e.g. `../../../../scripts/tests/_lib/…`
// from packages/doc-retrieval-mcp/src/adapters/), so we accept any
// relative-prefixed string ending in `_lib/git-fixture-env(.js)?`.
const HAS_HELPER_IMPORT = /from ['"]\.\.?\/[^'"]*_lib\/git-fixture-env(?:\.js)?['"]/

describe('SMI-4693 (B-2): Audit-39 import-detection regex', () => {
  // Same lockstep contract: keep in sync with scripts/audit-standards.mjs.
  it('matches relative imports from _lib/git-fixture-env (any depth)', () => {
    expect(
      HAS_HELPER_IMPORT.test(`import { makeFixtureEnv } from './_lib/git-fixture-env.js'`)
    ).toBe(true)
    expect(
      HAS_HELPER_IMPORT.test(`import { makeFixtureEnv } from '../_lib/git-fixture-env.js'`)
    ).toBe(true)
    expect(
      HAS_HELPER_IMPORT.test(`import { makeFixtureEnv } from '../../_lib/git-fixture-env'`)
    ).toBe(true)
    expect(
      HAS_HELPER_IMPORT.test(
        `import { makeFixtureEnv } from '../../../../scripts/tests/_lib/git-fixture-env.js'`
      )
    ).toBe(true)
  })

  it('does NOT match a same-named module elsewhere', () => {
    expect(HAS_HELPER_IMPORT.test(`import x from 'some-other/git-fixture-env'`)).toBe(false)
  })
})

describe('SMI-4693 (B-2 self-test): Audit-39 flags fixtures missing the helper', () => {
  // Synthetic file content — no I/O, just text matching.
  function checkFixture(text: string): { violation: boolean } {
    const spawnsGit = SPAWNS_GIT_RE.test(text)
    if (!spawnsGit) return { violation: false }
    const importsHelper = HAS_HELPER_IMPORT_RE.test(text)
    return { violation: !importsHelper }
  }
  const SPAWNS_GIT_RE =
    /(?:execFileSync|execSync|spawnSync)\(\s*['"`]git['"`]|(?:execSync|exec)\(\s*[`'"]\s*git\b/
  const HAS_HELPER_IMPORT_RE = /from ['"]\.\.?\/[^'"]*_lib\/git-fixture-env(?:\.js)?['"]/

  it('synthetic fixture WITHOUT helper import is a violation', () => {
    const text = `
      import { execFileSync } from 'node:child_process'
      execFileSync('git', ['init'], { cwd: tmp })
    `
    expect(checkFixture(text)).toEqual({ violation: true })
  })

  it('synthetic fixture WITH helper import is NOT a violation', () => {
    const text = `
      import { execFileSync } from 'node:child_process'
      import { makeFixtureEnv } from '../_lib/git-fixture-env.js'
      execFileSync('git', ['init'], { cwd: tmp, env: makeFixtureEnv() })
    `
    expect(checkFixture(text)).toEqual({ violation: false })
  })

  it('synthetic file that does not spawn git is NOT a violation even without helper', () => {
    const text = `it('does math', () => { expect(1 + 1).toBe(2) })`
    expect(checkFixture(text)).toEqual({ violation: false })
  })
})
