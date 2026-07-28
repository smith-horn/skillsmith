/**
 * SMI-5702: git-crypt filter registration self-heal tests.
 *
 * `filter.git-crypt.{smudge,clean,required}` and `diff.git-crypt.textconv`
 * are repo-SHARED state — even `git config --local` from inside a worktree
 * writes to the main checkout's $GIT_COMMON_DIR/config (git-crypt's own
 * worktreeConfig=true extension is set but unused). A worktree-creation or
 * rebase script that blindly `--unset`s these keys corrupts every worktree
 * AND the main checkout at once — this happened twice (SMI-5702, recurrence
 * 12 days later as SMI-5861). See
 * docs/internal/implementation/smi-5702-worktree-git-crypt-filter-deadlock.md
 * for the full root-cause writeup and the state table these tests cover.
 *
 * Exercises the real scripts/_lib.sh functions via `source` (no
 * reimplementation) — same harness shape as rebase-worktree.helpers.ts's
 * `sourceAndRun`. Fixtures are plain `git init` temp dirs: classification
 * and repair operate entirely on `git config --local`, so no bare/clone/
 * worktree trio is needed (unlike rebase-worktree.sh's heavier fixtures).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIB_SCRIPT = resolve(__dirname, '..', '_lib.sh')
const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()

// SMI-5702: ensure_git_crypt_filter_registered() gates any config WRITE on
// `command -v git-crypt` (never point config at a nonexistent binary) — but
// it never actually INVOKES git-crypt (repair is pure `git config` calls),
// so a do-nothing PATH shim is sufficient and keeps these tests hermetic
// regardless of whether the real binary happens to be installed in the
// environment running them (it is NOT inside this repo's own Docker dev
// container by design — git-crypt operations are host-side, see CLAUDE.md's
// Git-Crypt section — which is exactly the gap that first surfaced this).
const GIT_CRYPT_SHIM_DIR = mkdtempSync(join(tmpdir(), 'git-crypt-shim-'))
writeFileSync(join(GIT_CRYPT_SHIM_DIR, 'git-crypt'), '#!/bin/sh\nexit 0\n')
chmodSync(join(GIT_CRYPT_SHIM_DIR, 'git-crypt'), 0o755)
const GIT_ENV = { ...makeFixtureEnv(), PATH: `${GIT_CRYPT_SHIM_DIR}:${process.env.PATH ?? ''}` }

/** PATH with NO git-crypt reachable at all (neither the shim nor a real install), for T9. */
function pathWithoutAnyGitCrypt(): string {
  const real = (() => {
    const r = spawnSync('bash', ['-c', 'command -v git-crypt'], { encoding: 'utf8' })
    return r.status === 0 ? dirname(r.stdout.trim()) : null
  })()
  return (process.env.PATH ?? '')
    .split(':')
    .filter((p) => p !== GIT_CRYPT_SHIM_DIR && p !== real)
    .join(':')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

function makeRepo(): string {
  const dir = makeFixtureTempDir('git-crypt-filter-state')
  tempDirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: GIT_ENV })
  return dir
}

function setConfig(dir: string, key: string, value: string): void {
  execFileSync('git', ['-C', dir, 'config', '--local', key, value], { env: GIT_ENV })
}

function getConfig(dir: string, key: string): string {
  const result = spawnSync('git', ['-C', dir, 'config', '--local', '--get', key], {
    encoding: 'utf8',
    env: GIT_ENV,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
  combined: string
}

function sourceAndRun(call: string, extraEnv: Record<string, string> = {}): RunResult {
  const script = ['set -uo pipefail', `source ${JSON.stringify(LIB_SCRIPT)}`, call].join('\n')
  const result = spawnSync(REAL_BASH, ['-c', script], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...GIT_ENV, ...extraEnv },
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { status: result.status ?? 0, stdout, stderr, combined: stdout + stderr }
}

describe('classify_git_crypt_filter_state (SMI-5702)', () => {
  it('T1: CANONICAL — quoted spelling ("git-crypt" smudge/clean)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', '"git-crypt" smudge')
    setConfig(dir, 'filter.git-crypt.clean', '"git-crypt" clean')

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:CANONICAL')
  })

  it('T1b: CANONICAL — unquoted spelling (git-crypt smudge/clean) also accepted', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:CANONICAL')
  })

  it('T2: DISABLED — both exactly "cat"', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:DISABLED')
  })

  it('T3: MISSING — both absent', () => {
    const dir = makeRepo()

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:MISSING')
  })

  it('T4: HALF — smudge canonical, clean absent', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:HALF')
  })

  it('T4b: HALF variant — smudge canonical, clean "cat" (NOT DISABLED — that requires both)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:HALF')
  })

  it('T5: FOREIGN — present, non-canonical, not cat/cat', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', '/opt/custom/filter smudge')
    setConfig(dir, 'filter.git-crypt.clean', '/opt/custom/filter clean')

    const result = sourceAndRun(
      `classify_git_crypt_filter_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_FILTER_STATE"`
    )
    expect(result.stdout).toContain('STATE:FOREIGN')
  })
})

describe('ensure_git_crypt_filter_registered (SMI-5702)', () => {
  it('T1: CANONICAL — no-op, zero config writes (guards R1 churn bug)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', '"git-crypt" smudge')
    setConfig(dir, 'filter.git-crypt.clean', '"git-crypt" clean')
    setConfig(dir, 'filter.git-crypt.required', 'true')
    setConfig(dir, 'diff.git-crypt.textconv', '"git-crypt" diff')
    const before = execFileSync(
      'git',
      ['-C', dir, 'config', '--local', '--get-regexp', 'filter\\.git-crypt|diff\\.git-crypt'],
      { encoding: 'utf8', env: GIT_ENV }
    )

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)

    const after = execFileSync(
      'git',
      ['-C', dir, 'config', '--local', '--get-regexp', 'filter\\.git-crypt|diff\\.git-crypt'],
      { encoding: 'utf8', env: GIT_ENV }
    )
    expect(after).toBe(before)
    expect(result.combined).not.toMatch(/repaired|HALF|FOREIGN|missing/i)
  })

  it('T2: DISABLED — smudge/clean untouched, warns, but `required` still repaired to true', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')
    // required intentionally left absent to prove it's repaired even here.

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(result.combined.toLowerCase()).toContain('disabled')
    expect(result.combined).toContain('worktree-crypt.sh fix')

    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.required')).toBe('true')
  })

  it('T3: MISSING — both written to canonical, success message only (no warn), read-back verified', () => {
    const dir = makeRepo()

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(result.combined).not.toMatch(/warn/i)

    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(getConfig(dir, 'filter.git-crypt.required')).toBe('true')
    expect(getConfig(dir, 'diff.git-crypt.textconv')).toBe('"git-crypt" diff')
  })

  it('T4: HALF — both canonical after, warn names both pre-image values', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(result.combined.toLowerCase()).toContain('half')
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
  })

  it('T5: FOREIGN — overwritten, warn names the old value verbatim', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', '/opt/custom/filter smudge')
    setConfig(dir, 'filter.git-crypt.clean', '/opt/custom/filter clean')

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(result.combined).toContain('/opt/custom/filter smudge')
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
  })

  it('T6: SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE=1 from MISSING — full no-op, zero writes, informational message', () => {
    const dir = makeRepo()

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`, {
      SKILLSMITH_GIT_CRYPT_FILTER_HEAL_DISABLE: '1',
    })
    expect(result.status).toBe(0)
    expect(result.combined.toLowerCase()).toContain('disabled')

    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('')
    expect(getConfig(dir, 'filter.git-crypt.required')).toBe('')
  })

  it('T7: required absent, smudge/clean CANONICAL — required=true written (the silent-plaintext path)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')
    setConfig(dir, 'diff.git-crypt.textconv', '"git-crypt" diff')

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(getConfig(dir, 'filter.git-crypt.required')).toBe('true')
  })

  it('T8: diff.git-crypt.textconv absent — restored', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')
    setConfig(dir, 'filter.git-crypt.required', 'true')

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(getConfig(dir, 'diff.git-crypt.textconv')).toBe('"git-crypt" diff')
  })

  it('T9: git-crypt binary absent from PATH — fails with the install remediation, writes nothing', () => {
    const dir = makeRepo() // MISSING state

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`, {
      PATH: pathWithoutAnyGitCrypt(),
    })
    expect(result.status).not.toBe(0)
    expect(result.combined.toLowerCase()).toContain('git-crypt')
    expect(result.combined.toLowerCase()).toMatch(/install|not on path/)

    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('')
    expect(getConfig(dir, 'filter.git-crypt.required')).toBe('')
  })

  it('T10: post-write read-back mismatch (injected) — hard-fails, never reports success', () => {
    const dir = makeRepo() // MISSING state

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`, {
      SKILLSMITH_GIT_CRYPT_FILTER_FORCE_READBACK_MISMATCH_TEST: '1',
    })
    // The "repaired (was missing)" progress line is expected here — it's
    // accurate up to that point (the write itself succeeded); the read-back
    // check runs immediately after and is what must have the final word:
    // the overall invocation hard-fails (nonzero exit) rather than exiting
    // 0 the way a genuinely successful repair would.
    expect(result.status).not.toBe(0)
    expect(result.combined.toLowerCase()).toContain('read-back verification failed')
    // The FOREIGN state the injected corruption produces is named verbatim,
    // not swallowed.
    expect(result.combined).toContain('corrupted-by-test')
  })
})

describe('has_git_crypt_magic_header / find_encrypted_test_file (SMI-5702)', () => {
  it('has_git_crypt_magic_header detects the \\0GITCRYPT\\0 prefix without xxd', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      [
        `printf '\\000GITCRYPT\\000restofblob' > ${JSON.stringify(dir)}/enc.bin`,
        `has_git_crypt_magic_header ${JSON.stringify(dir)}/enc.bin && echo MATCH || echo NOMATCH`,
      ].join('\n')
    )
    expect(result.stdout).toContain('MATCH')
  })

  it('has_git_crypt_magic_header returns false for plaintext', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      [
        `printf 'hello world' > ${JSON.stringify(dir)}/plain.txt`,
        `has_git_crypt_magic_header ${JSON.stringify(dir)}/plain.txt && echo MATCH || echo NOMATCH`,
      ].join('\n')
    )
    expect(result.stdout).toContain('NOMATCH')
  })

  it('find_encrypted_test_file returns a real on-disk file under the first git-crypt .gitattributes prefix', () => {
    const dir = makeRepo()
    execFileSync('bash', ['-c', `mkdir -p ${JSON.stringify(dir)}/enc/functions`])
    execFileSync('bash', [
      '-c',
      `printf 'enc/functions/** filter=git-crypt diff=git-crypt\\n' > ${JSON.stringify(dir)}/.gitattributes`,
    ])
    execFileSync('bash', [
      '-c',
      `printf 'ciphertext' > ${JSON.stringify(dir)}/enc/functions/secret.ts`,
    ])

    const result = sourceAndRun(`find_encrypted_test_file ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toContain('enc/functions/secret.ts')
  })

  it('find_encrypted_test_file returns nothing (exit 1) when .gitattributes has no git-crypt filter', () => {
    const dir = makeRepo()
    const result = sourceAndRun(`find_encrypted_test_file ${JSON.stringify(dir)}; echo "RC:$?"`)
    expect(result.stdout).toContain('RC:1')
    expect(result.stdout.trim()).toBe('RC:1')
  })
})
