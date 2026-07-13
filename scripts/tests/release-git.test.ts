/**
 * Tests for scripts/lib/release-git.ts — SMI-4775 lockfile regen + createCommit lockfile inclusion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

// ESM-safe module mocks (must be declared before importing SUT).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

import { regenerateLockfile, createCommit, buildFilesToAdd } from '../lib/release-git'
import { PACKAGE_SPECS, ROOT_DIR } from '../lib/version-utils'
import type { BumpPlan } from '../lib/release-collision'

const mockedExecFileSync = vi.mocked(execFileSync)

const corePlan: BumpPlan = {
  spec: PACKAGE_SPECS.find((s) => s.shortName === 'core')!,
  currentVersion: '0.5.8',
  newVersion: '0.6.0',
}

const mcpServerPlan: BumpPlan = {
  spec: PACKAGE_SPECS.find((s) => s.shortName === 'mcp-server')!,
  currentVersion: '0.6.1',
  newVersion: '0.6.2',
}

describe('regenerateLockfile (SMI-4775)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockReturnValue('' as never)
  })

  it("calls 'npm install --package-lock-only --ignore-scripts' from ROOT_DIR", () => {
    regenerateLockfile()
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = mockedExecFileSync.mock.calls[0]!
    expect(cmd).toBe('npm')
    expect(args).toEqual(['install', '--package-lock-only', '--ignore-scripts'])
    expect(opts).toMatchObject({ cwd: ROOT_DIR, stdio: 'inherit' })
  })
})

describe('createCommit lockfile inclusion (SMI-4775)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockReturnValue('' as never)
  })

  it("does NOT add 'package-lock.json' to git add when includeLockfile is omitted (back-compat default)", () => {
    createCommit([corePlan])
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    expect(addCall).toBeDefined()
    const addArgs = addCall![1] as string[]
    expect(addArgs).not.toContain('package-lock.json')
  })

  it("adds 'package-lock.json' to git add when includeLockfile=true", () => {
    createCommit([corePlan], true)
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    expect(addCall).toBeDefined()
    const addArgs = addCall![1] as string[]
    expect(addArgs).toContain('package-lock.json')
  })

  it("does NOT add 'package-lock.json' when includeLockfile=false (--no-lockfile-regen path)", () => {
    createCommit([corePlan], false)
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    const addArgs = addCall![1] as string[]
    expect(addArgs).not.toContain('package-lock.json')
  })
})

describe('buildFilesToAdd (SMI-5672)', () => {
  // buildFilesToAdd does no git I/O — no execFileSync mocking needed here.
  // The existsSync filter is exercised against REAL files in this repo
  // (corePlan's derived paths all exist on disk), matching this test file's
  // established convention of using real PACKAGE_SPECS-derived plans.

  it('includes extraFiles entries in the returned list', () => {
    const files = buildFilesToAdd([corePlan], { extraFiles: ['packages/cli/package.json'] })
    expect(files).toContain('packages/cli/package.json')
  })

  it('orders plan-derived files before extraFiles', () => {
    const files = buildFilesToAdd([corePlan], { extraFiles: ['packages/cli/package.json'] })
    expect(files).toEqual([
      'packages/core/package.json',
      'packages/core/src/index.ts',
      'packages/core/CHANGELOG.md',
      'packages/cli/package.json',
    ])
  })

  it('de-duplicates when an extraFiles entry coincides with a plan-derived path', () => {
    const files = buildFilesToAdd([corePlan], {
      extraFiles: ['packages/core/package.json', 'packages/cli/package.json'],
    })
    expect(files.filter((f) => f === 'packages/core/package.json')).toHaveLength(1)
    expect(files).toEqual([
      'packages/core/package.json',
      'packages/core/src/index.ts',
      'packages/core/CHANGELOG.md',
      'packages/cli/package.json',
    ])
  })

  it('includes package-lock.json when includeLockfile is true', () => {
    const files = buildFilesToAdd([corePlan], { includeLockfile: true })
    expect(files).toContain('package-lock.json')
  })

  it('omits package-lock.json when includeLockfile is omitted or false', () => {
    expect(buildFilesToAdd([corePlan])).not.toContain('package-lock.json')
    expect(buildFilesToAdd([corePlan], { includeLockfile: false })).not.toContain(
      'package-lock.json'
    )
  })

  it('omits each plan CHANGELOG.md when noChangelog is true', () => {
    const files = buildFilesToAdd([corePlan], { noChangelog: true })
    expect(files).not.toContain('packages/core/CHANGELOG.md')
  })

  it('includes each plan CHANGELOG.md when noChangelog is omitted or false', () => {
    expect(buildFilesToAdd([corePlan])).toContain('packages/core/CHANGELOG.md')
    expect(buildFilesToAdd([corePlan], { noChangelog: false })).toContain(
      'packages/core/CHANGELOG.md'
    )
  })

  it('only returns files that actually exist on disk (existsSync filter)', () => {
    const fakePlan: BumpPlan = {
      spec: {
        name: 'fake-package',
        shortName: 'fake',
        dir: 'packages/nonexistent',
        packageJsonPath: 'packages/nonexistent/package.json',
      },
      currentVersion: '1.0.0',
      newVersion: '1.0.1',
    }
    const files = buildFilesToAdd([fakePlan], { extraFiles: ['packages/cli/package.json'] })
    expect(files).not.toContain('packages/nonexistent/package.json')
    expect(files).not.toContain('packages/nonexistent/CHANGELOG.md')
    expect(files).toEqual(['packages/cli/package.json'])
  })
})

describe('createCommit dep-range file staging (SMI-5672)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockReturnValue('' as never)
  })

  it('stages sibling dep-range files passed via extraFiles for a non-core bump', () => {
    // This is the precise shape that shipped broken: a non-core (mcp-server)
    // bump whose sibling dep-range files (cli, enterprise) were written by
    // updateWorkspaceDependencies but never reached `git add`.
    createCommit([mcpServerPlan], true, [
      'packages/cli/package.json',
      'packages/enterprise/package.json',
    ])
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    expect(addCall).toBeDefined()
    const addArgs = addCall![1] as string[]
    expect(addArgs).toContain('packages/cli/package.json')
    expect(addArgs).toContain('packages/enterprise/package.json')
  })

  it('does NOT auto-stage sibling package.json files for a core bump with no extraFiles (CORE_DEPENDENTS removed)', () => {
    createCommit([corePlan])
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    expect(addCall).toBeDefined()
    const addArgs = addCall![1] as string[]
    expect(addArgs).not.toContain('packages/mcp-server/package.json')
    expect(addArgs).not.toContain('packages/cli/package.json')
    expect(addArgs).not.toContain('packages/enterprise/package.json')
  })
})

describe('createCommit real-git integration (SMI-5672)', () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
    vi.doUnmock('../lib/version-utils')
    vi.resetModules()
    // Restore the module-level execFileSync mock to forward to the real
    // implementation for any tests that run after this one in the file.
    const cp = await vi.importActual<typeof import('child_process')>('child_process')
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockImplementation(cp.execFileSync)
  })

  it('stages every file buildFilesToAdd reports into a real commit (git diff-tree / show --stat), entirely inside a scratch temp repo', async () => {
    // `createCommit` hardcodes `cwd: ROOT_DIR` (the real repo root), so it
    // cannot be pointed at a scratch directory directly. Instead: (1) build a
    // fresh copy of `buildFilesToAdd` whose `ROOT_DIR` dependency is mocked to
    // the temp dir, so its internal existsSync filter checks the temp dir's
    // fixture files rather than the real repo, then (2) replicate createCommit's
    // exact `git add` + `git commit` sequence against that temp dir via real
    // (non-mocked-return) execFileSync calls. Nothing here touches the real
    // repo's git state.
    tmpDir = makeFixtureTempDir('release-git-test')
    const fixtureEnv = makeFixtureEnv()

    const cp = await vi.importActual<typeof import('child_process')>('child_process')
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockImplementation(cp.execFileSync)

    // SMI-4693: every git invocation against the scratch repo below must pass
    // `env: fixtureEnv` — it strips GIT_DISCOVERY_VARS and pins author/committer
    // identity so a stray env var inherited from the vitest worker can't
    // redirect these spawns into the parent worktree.
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe', env: fixtureEnv })

    mkdirSync(join(tmpDir, 'packages/widget'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'packages/widget/package.json'),
      JSON.stringify({ name: 'widget', version: '1.0.0' }, null, 2)
    )
    writeFileSync(join(tmpDir, 'packages/widget/CHANGELOG.md'), '## v1.0.0\n')
    mkdirSync(join(tmpDir, 'packages/sibling'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'packages/sibling/package.json'),
      JSON.stringify(
        { name: 'sibling', version: '2.0.0', dependencies: { widget: '^1.0.0' } },
        null,
        2
      )
    )

    vi.resetModules()
    vi.doMock('../lib/version-utils', async () => {
      const actual =
        await vi.importActual<typeof import('../lib/version-utils')>('../lib/version-utils')
      return { ...actual, ROOT_DIR: tmpDir }
    })

    const { buildFilesToAdd: buildFilesToAddInTmp } = await import('../lib/release-git')

    const widgetPlan: BumpPlan = {
      spec: {
        name: 'widget',
        shortName: 'widget',
        dir: 'packages/widget',
        packageJsonPath: 'packages/widget/package.json',
      },
      currentVersion: '0.9.0',
      newVersion: '1.0.0',
    }

    const files = buildFilesToAddInTmp([widgetPlan], {
      extraFiles: ['packages/sibling/package.json'],
    })

    expect(files).toEqual([
      'packages/widget/package.json',
      'packages/widget/CHANGELOG.md',
      'packages/sibling/package.json',
    ])

    // Replicate createCommit's exact git add + git commit sequence.
    execFileSync('git', ['add', ...files], { cwd: tmpDir, stdio: 'pipe', env: fixtureEnv })
    execFileSync('git', ['commit', '-m', 'chore(release): test commit'], {
      cwd: tmpDir,
      stdio: 'pipe',
      env: fixtureEnv,
    })

    // --root is required for diff-tree to list files on a repo's FIRST
    // (parent-less) commit — without it, diff-tree has nothing to diff
    // against and silently reports zero changed files.
    const committedFiles = execFileSync(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'],
      { cwd: tmpDir, encoding: 'utf-8', env: fixtureEnv }
    )
      .trim()
      .split('\n')

    for (const f of files) {
      expect(committedFiles).toContain(f)
    }

    const stat = execFileSync('git', ['show', '--stat', 'HEAD'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: fixtureEnv,
    })
    for (const f of files) {
      expect(stat).toContain(f)
    }
  })
})
