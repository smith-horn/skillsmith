import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const SCRIPT_PATH = join(__dirname, '..', 'sync-main.sh')
const GIT_ENV = makeFixtureEnv({ GIT_ALLOW_PROTOCOL: 'file' })
const tempDirs: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: GIT_ENV,
    }
  ).trim()
}

function runSync(cwd: string): { status: number; output: string } {
  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 30_000,
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

interface Fixture {
  root: string
  parentSource: string
  syncClone: string
  subABare: string
  subBBare: string
}

function seedSubmodule(root: string, bare: string, name: string): void {
  const seed = join(root, `${name}-seed`)
  git(root, 'init', '--bare', bare)
  git(root, 'clone', bare, seed)
  writeFileSync(join(seed, `${name}.md`), `${name} initial\n`)
  git(seed, 'add', `${name}.md`)
  git(seed, 'commit', '-m', `${name} initial`)
  git(seed, 'push', 'origin', 'main')
}

function makeFixture(): Fixture {
  const root = makeFixtureTempDir('sync-main')
  tempDirs.push(root)

  const parentBare = join(root, 'parent-bare.git')
  const parentSource = join(root, 'parent-source')
  const syncClone = join(root, 'sync-clone')
  const subABare = join(root, 'subA-bare.git')
  const subBBare = join(root, 'subB-bare.git')

  git(root, 'init', '--bare', parentBare)
  seedSubmodule(root, subABare, 'subA')
  seedSubmodule(root, subBBare, 'subB')

  git(root, 'clone', parentBare, parentSource)
  writeFileSync(join(parentSource, 'README.md'), 'parent\n')
  git(parentSource, 'add', 'README.md')
  git(parentSource, 'commit', '-m', 'parent initial')
  git(parentSource, 'submodule', 'add', subABare, 'docs/internal')
  git(parentSource, 'submodule', 'add', subBBare, '.claude/skills')
  git(parentSource, 'commit', '-m', 'add submodules')
  git(parentSource, 'push', 'origin', 'main')

  git(root, 'clone', parentBare, syncClone)
  // The production remotes are HTTPS. Fixtures use local bare repositories,
  // so allow file transport for submodule fetches spawned by sync-main.sh.
  git(syncClone, 'config', '--local', 'protocol.file.allow', 'always')
  git(syncClone, 'submodule', 'update', '--init')

  return { root, parentSource, syncClone, subABare, subBBare }
}

function advanceSubmodule(fixture: Fixture, path: 'docs/internal' | '.claude/skills'): string {
  const isA = path === 'docs/internal'
  const bare = isA ? fixture.subABare : fixture.subBBare
  const name = isA ? 'subA' : 'subB'
  const advance = join(fixture.root, `${name}-advance-${Date.now()}`)

  git(fixture.root, 'clone', bare, advance)
  writeFileSync(join(advance, `${name}-advance.md`), `${name} advance\n`)
  git(advance, 'add', `${name}-advance.md`)
  git(advance, 'commit', '-m', `${name} advance`)
  git(advance, 'push', 'origin', 'main')
  const sha = git(advance, 'rev-parse', 'HEAD')

  git(fixture.parentSource, 'submodule', 'update', '--remote', '--', path)
  git(fixture.parentSource, 'add', path)
  git(fixture.parentSource, 'commit', '-m', `bump ${name}`)
  git(fixture.parentSource, 'push', 'origin', 'main')
  return sha
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

describe('SMI-5823 Phase 2: sync-main submodule alignment', () => {
  it('updates every submodule to the gitlinks recorded by origin/main', () => {
    const fixture = makeFixture()
    const expectedA = advanceSubmodule(fixture, 'docs/internal')
    const expectedB = advanceSubmodule(fixture, '.claude/skills')

    const result = runSync(fixture.syncClone)

    expect(result.status, result.output).toBe(0)
    expect(git(join(fixture.syncClone, 'docs/internal'), 'rev-parse', 'HEAD'), result.output).toBe(
      expectedA
    )
    expect(git(join(fixture.syncClone, '.claude/skills'), 'rev-parse', 'HEAD')).toBe(expectedB)
    expect(result.output).not.toContain('Submodule sync incomplete')
  })

  it('continues updating other paths and names an inaccessible submodule', () => {
    const fixture = makeFixture()
    const expectedA = advanceSubmodule(fixture, 'docs/internal')
    const expectedB = advanceSubmodule(fixture, '.claude/skills')
    const subB = join(fixture.syncClone, '.claude/skills')
    const oldB = git(subB, 'rev-parse', 'HEAD')
    git(subB, 'remote', 'set-url', 'origin', join(fixture.root, 'missing.git'))

    const result = runSync(fixture.syncClone)

    expect(result.status, result.output).toBe(0)
    expect(git(join(fixture.syncClone, 'docs/internal'), 'rev-parse', 'HEAD'), result.output).toBe(
      expectedA
    )
    expect(git(subB, 'rev-parse', 'HEAD')).toBe(oldB)
    expect(result.output).toContain(
      `.claude/skills: update failed (found ${oldB.slice(0, 12)}, expected ${expectedB.slice(0, 12)})`
    )
    expect(result.output).not.toContain('docs/internal:')
  })

  it('preserves a dirty submodule and reports its exact mismatch', () => {
    const fixture = makeFixture()
    const subA = join(fixture.syncClone, 'docs/internal')
    const oldA = git(subA, 'rev-parse', 'HEAD')
    const expectedA = advanceSubmodule(fixture, 'docs/internal')
    writeFileSync(join(subA, 'subA.md'), 'dirty local work\n')

    const result = runSync(fixture.syncClone)

    expect(result.status, result.output).toBe(0)
    expect(git(subA, 'rev-parse', 'HEAD')).toBe(oldA)
    expect(git(subA, 'status', '--porcelain')).toContain('M subA.md')
    expect(result.output).toContain(
      `docs/internal: dirty worktree preserved (found ${oldA.slice(0, 12)}, expected ${expectedA.slice(0, 12)})`
    )
  })
})
