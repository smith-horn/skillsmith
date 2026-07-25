import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CREATE_WORKTREE_SCRIPT = resolve(__dirname, '..', 'create-worktree.sh')
const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()

type Fixture = {
  root: string
  source: string
  clone: string
  remote: string
  localMain: string
  remoteMain: string
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim()
}

function makeFixture(): Fixture {
  const root = makeFixtureTempDir('create-worktree-base')
  const env = makeFixtureEnv()
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const clone = join(root, 'clone')

  execFileSync('git', ['init', '--bare', '--quiet', remote], { env })
  execFileSync('git', ['clone', '--quiet', remote, source], { env })
  writeFileSync(join(source, 'README.md'), 'one\n')
  git(source, ['add', 'README.md'], env)
  git(source, ['commit', '--quiet', '-m', 'initial'], env)
  git(source, ['push', '--quiet', '-u', 'origin', 'HEAD:main'], env)
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { env })
  execFileSync('git', ['clone', '--quiet', remote, clone], { env })

  const localMain = git(clone, ['rev-parse', 'main'], env)
  writeFileSync(join(source, 'README.md'), 'two\n')
  git(source, ['commit', '--quiet', '-am', 'advance'], env)
  git(source, ['push', '--quiet', 'origin', 'HEAD:main'], env)
  const remoteMain = git(source, ['rev-parse', 'HEAD'], env)

  return { root, source, clone, remote, localMain, remoteMain }
}

function runAdd(fixture: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const script = [
    'set -euo pipefail',
    `source ${JSON.stringify(CREATE_WORKTREE_SCRIPT)}`,
    'USE_EXISTING_BRANCH="$1"',
    'add_worktree_git_entry "$2" "$3" "$4"',
  ].join('\n')
  return spawnSync(REAL_BASH, ['-c', script, 'test', ...args], {
    cwd: fixture.clone,
    encoding: 'utf8',
    env: { ...makeFixtureEnv(), ...extraEnv },
  })
}

describe('create-worktree.sh default-base selection', () => {
  let fixture: Fixture | undefined

  afterEach(() => {
    if (fixture && existsSync(fixture.root)) rmSync(fixture.root, { recursive: true, force: true })
    fixture = undefined
  })

  it('bases a new main-based branch on fetched origin/main without moving local main', () => {
    fixture = makeFixture()
    const worktree = join(fixture.root, 'fresh-worktree')

    const result = runAdd(fixture, ['false', worktree, 'feature/fresh', 'main'])

    expect(result.status).toBe(0)
    expect(git(worktree, ['rev-parse', 'HEAD'], makeFixtureEnv())).toBe(fixture.remoteMain)
    expect(git(fixture.clone, ['rev-parse', 'main'], makeFixtureEnv())).toBe(fixture.localMain)
  })

  it('reuses an existing branch without fetching or selecting a new base', () => {
    fixture = makeFixture()
    const worktree = join(fixture.root, 'existing-worktree')
    git(fixture.clone, ['branch', 'feature/existing', fixture.localMain], makeFixtureEnv())
    git(
      fixture.clone,
      ['remote', 'set-url', 'origin', join(fixture.root, 'missing.git')],
      makeFixtureEnv()
    )

    const result = runAdd(fixture, ['true', worktree, 'feature/existing', 'main'])

    expect(result.status).toBe(0)
    expect(git(worktree, ['rev-parse', 'HEAD'], makeFixtureEnv())).toBe(fixture.localMain)
  })

  it('aborts on fetch failure before creating a branch or worktree', () => {
    fixture = makeFixture()
    const worktree = join(fixture.root, 'failed-worktree')
    git(
      fixture.clone,
      ['remote', 'set-url', 'origin', join(fixture.root, 'missing.git')],
      makeFixtureEnv()
    )

    const result = runAdd(fixture, ['false', worktree, 'feature/failed', 'main'])

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('stopped before creating')
    expect(existsSync(worktree)).toBe(false)
    expect(
      spawnSync('git', ['-C', fixture.clone, 'show-ref', '--verify', 'refs/heads/feature/failed'], {
        env: makeFixtureEnv(),
      }).status
    ).not.toBe(0)
  })
})
