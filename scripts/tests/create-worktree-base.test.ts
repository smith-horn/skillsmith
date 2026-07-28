import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import {
  setupGitCryptFixture,
  disableGitCryptFilters,
  hasCiphertextPrefix,
  GIT_CRYPT_SHIM_PATH,
  GIT_CRYPT_ROUNDTRIP_SHIM_PATH,
} from './rebase-worktree.helpers.js'

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

/**
 * SMI-5702: Step 3c (ensure_git_crypt_filter_registered, new — runs before
 * Step 4's `git reset --hard HEAD`) and Step 4a / Half 2
 * (scan_ciphertext, new — runs after). Drives the real functions directly
 * (source create-worktree.sh, which also sources _rebase-git-crypt.sh for
 * scan_ciphertext) rather than the full create_worktree(), which pulls in
 * unrelated Docker/mcp.json/submodule machinery this fixture doesn't need.
 * Uses the portable git-crypt-filter-pair simulation from
 * rebase-worktree.helpers.ts (no real git-crypt binary/key material
 * required), same convention as rebase-worktree.git-crypt-resmudge.test.ts.
 */
describe('create-worktree.sh Step 3c / Half 2 (SMI-5702 git-crypt filter registration)', () => {
  let root: string | undefined

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function makeGitCryptFixture(): { clone: string; worktree: string } {
    root = makeFixtureTempDir('create-worktree-gitcrypt')
    const env = makeFixtureEnv()
    const bare = join(root, 'bare.git')
    const clone = join(root, 'clone')
    execFileSync('git', ['init', '--bare', '--quiet', bare], { env })
    execFileSync('git', ['clone', '--quiet', bare, clone], { env })
    setupGitCryptFixture(clone, 'enc')
    writeFileSync(join(clone, 'enc', 'secret.txt'), 'top secret\n')
    git(clone, ['add', '.gitattributes', 'enc/secret.txt'], env)
    git(clone, ['commit', '--quiet', '-m', 'initial'], env)
    git(clone, ['push', '--quiet', 'origin', 'HEAD:main'], env)
    const worktree = join(root as string, 'wt')
    return { clone, worktree }
  }

  it('Step 3c heals a MISSING filter before Step 4 checkout, preventing ciphertext-on-disk corruption', () => {
    root = makeFixtureTempDir('create-worktree-gitcrypt-canonical')
    // SMI-5702: uses the FUNCTIONAL round-trip shim and registers the
    // CANONICAL "git-crypt smudge"/"git-crypt clean" spelling from the
    // start (what ensure_git_crypt_filter_registered() always heals TO) so
    // the checked-out content can be asserted byte-for-byte, not just
    // "isn't the raw ciphertext prefix" (which scan_ciphertext alone would
    // still pass on, e.g., empty content from a no-op filter).
    const env = { ...makeFixtureEnv(), PATH: GIT_CRYPT_ROUNDTRIP_SHIM_PATH }
    const bare = join(root, 'bare.git')
    const clone = join(root, 'clone')
    const worktree = join(root, 'wt')
    execFileSync('git', ['init', '--bare', '--quiet', bare], { env })
    execFileSync('git', ['clone', '--quiet', bare, clone], { env })
    git(clone, ['config', 'filter.git-crypt.smudge', 'git-crypt smudge'], env)
    git(clone, ['config', 'filter.git-crypt.clean', 'git-crypt clean'], env)
    writeFileSync(join(clone, '.gitattributes'), 'enc/** filter=git-crypt diff=git-crypt\n')
    mkdirSync(join(clone, 'enc'), { recursive: true })
    writeFileSync(join(clone, 'enc', 'secret.txt'), 'top secret\n')
    git(clone, ['add', '.gitattributes', 'enc/secret.txt'], env)
    git(clone, ['commit', '--quiet', '-m', 'initial'], env)
    git(clone, ['push', '--quiet', 'origin', 'HEAD:main'], env)

    // Break the filter (mirrors a prior corrupted rebase remediation) BEFORE
    // creating the worktree — filter.git-crypt.* is repo-shared, so this
    // reproduces the exact live-verified corruption precondition.
    spawnSync('git', ['-C', clone, 'config', '--local', '--unset', 'filter.git-crypt.smudge'], {
      env,
    })
    spawnSync('git', ['-C', clone, 'config', '--local', '--unset', 'filter.git-crypt.clean'], {
      env,
    })

    execFileSync(
      'git',
      ['-C', clone, 'worktree', 'add', '--no-checkout', worktree, '-b', 'feature'],
      { env }
    )

    const script = [
      'set -euo pipefail',
      `source ${JSON.stringify(CREATE_WORKTREE_SCRIPT)}`,
      `ensure_git_crypt_filter_registered ${JSON.stringify(worktree)}`, // Step 3c
      `(cd ${JSON.stringify(worktree)} && git reset --hard HEAD)`, // Step 4
      `scan_ciphertext ${JSON.stringify(worktree)}`, // Step 4a
    ].join('\n')
    const result = spawnSync(REAL_BASH, ['-c', script], { encoding: 'utf8', env })

    expect(result.status).toBe(0)
    expect(readFileSync(join(worktree, 'enc', 'secret.txt'), 'utf8')).toBe('top secret\n')
  })

  it('Half 2 (scan_ciphertext) detects a DISABLED-filter checkout that wrote raw ciphertext, and leaves the file intact', () => {
    const { clone, worktree } = makeGitCryptFixture()
    const env = makeFixtureEnv()

    // Simulate another session's live conflict-resolution window: filters
    // deliberately disabled (cat/cat). Step 3c's DISABLED exemption must NOT
    // heal this — so the checkout below writes real ciphertext to disk,
    // exactly as verified live during this plan's repro.
    disableGitCryptFilters(clone)

    execFileSync(
      'git',
      ['-C', clone, 'worktree', 'add', '--no-checkout', worktree, '-b', 'feature'],
      { env }
    )

    const script = [
      'set -euo pipefail',
      `source ${JSON.stringify(CREATE_WORKTREE_SCRIPT)}`,
      `ensure_git_crypt_filter_registered ${JSON.stringify(worktree)}`, // Step 3c: DISABLED -> no-op on smudge/clean, but required/textconv still repaired
      `(cd ${JSON.stringify(worktree)} && git reset --hard HEAD)`, // Step 4: writes ciphertext under cat/cat
      `scan_ciphertext ${JSON.stringify(worktree)}`, // Step 4a: must fail
    ].join('\n')
    // SMI-5702: even in DISABLED, the secondary axis (required/textconv) is
    // absent in this fixture and needs repair -- same shim rationale as above.
    const result = spawnSync(REAL_BASH, ['-c', script], {
      encoding: 'utf8',
      env: { ...env, PATH: GIT_CRYPT_SHIM_PATH },
    })

    expect(result.status).not.toBe(0)
    expect(hasCiphertextPrefix(join(worktree, 'enc', 'secret.txt'))).toBe(true)
    // Worktree left intact (file still present, not deleted) so worktree-crypt.sh fix can run.
    expect(existsSync(join(worktree, 'enc', 'secret.txt'))).toBe(true)
  })

  it('create_worktree() names the [git-crypt-verify] marker and both possible causes on a Half 2 failure', () => {
    const source = readFileSync(CREATE_WORKTREE_SCRIPT, 'utf8')
    expect(source).toContain('[git-crypt-verify]')
    expect(source).toContain('worktree-crypt.sh fix $worktree_path')
    // Both causes named, per the plan: another session's DISABLED window, or
    // a genuinely broken key/filter.
    expect(source).toMatch(/deliberate git-crypt filter disable/)
    expect(source).toMatch(/genuinely broken git-crypt key or filter registration/)
  })
})
