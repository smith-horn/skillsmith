/**
 * SMI-5426 W0.1 — unit tests for the shared auto-heal state module.
 *
 * No mocking needed — all filesystem writes go to unique per-test tmp paths,
 * and git fixture helpers ensure resolveMainRepoKey runs against an isolated
 * repo rather than the real project worktree.
 *
 * Never touches the real ~/.skillsmith state. SKILLSMITH_AUTOHEAL_HOME is
 * saved and restored around each test that changes it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  ATTEMPT_CAP,
  AUTOHEAL_DISABLE_VAR,
  BACKOFF_SECONDS,
  cooldownDecision,
  readEntry,
  readState,
  recordResult,
  renderAutohealBanner,
  resolveAutohealLogPath,
  resolveAutohealStateDir,
  resolveMainRepoKey,
  writeEntry,
  type AutohealEntry,
} from './autoheal-state.js'
import { makeFixtureEnv, makeFixtureTempDir } from '../_lib/git-fixture-env.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Create a unique tmp state file path that never touches ~/.skillsmith. */
function makeTmpStatePath(): string {
  const dir = tmpDir()
  return join(dir, 'retrieval-autoheal.state')
}

function makeEntry(overrides: Partial<AutohealEntry> = {}): AutohealEntry {
  return {
    lastAttemptEpoch: 1_700_000_000,
    consecutiveFailures: 0,
    lastVerdict: 'ok',
    ...overrides,
  }
}

// Track dirs to clean up.
const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function tmpDir(): string {
  const d = makeFixtureTempDir('autoheal-state-test')
  tmpDirs.push(d)
  return d
}

// ── resolveAutohealLogPath ──────────────────────────────────────────────────────

describe('resolveAutohealLogPath', () => {
  it('returns a per-day log path under the state dir (YYYY-MM-DD, local)', () => {
    // Date string with no Z is parsed as LOCAL time, so the day is TZ-stable.
    const p = resolveAutohealLogPath(new Date('2026-06-28T12:00:00'))
    expect(p).toContain('.skillsmith')
    expect(p).toMatch(/retrieval-autoheal-2026-06-28\.log$/)
  })
})

// ── cooldownDecision ───────────────────────────────────────────────────────────

describe('cooldownDecision', () => {
  const now = 1_700_100_000

  it('null entry → run', () => {
    expect(cooldownDecision(null, now)).toEqual({ action: 'run' })
  })

  it('cf=0 → run', () => {
    const entry = makeEntry({ consecutiveFailures: 0, lastVerdict: 'ok' })
    expect(cooldownDecision(entry, now)).toEqual({ action: 'run' })
  })

  it('cf=1 within 3600s → cooldown with untilEpoch=lastAttempt+3600', () => {
    const lastAttempt = now - 100
    const entry = makeEntry({
      consecutiveFailures: 1,
      lastAttemptEpoch: lastAttempt,
      lastVerdict: 'fail',
    })
    const result = cooldownDecision(entry, now)
    expect(result.action).toBe('cooldown')
    if (result.action === 'cooldown') {
      expect(result.untilEpoch).toBe(lastAttempt + BACKOFF_SECONDS[1])
      expect(result.untilEpoch).toBe(lastAttempt + 3600)
    }
  })

  it('cf=1 after 3600s → run', () => {
    const lastAttempt = now - 3601
    const entry = makeEntry({
      consecutiveFailures: 1,
      lastAttemptEpoch: lastAttempt,
      lastVerdict: 'fail',
    })
    expect(cooldownDecision(entry, now)).toEqual({ action: 'run' })
  })

  it('cf=2 within 14400s → cooldown', () => {
    const lastAttempt = now - 100
    const entry = makeEntry({
      consecutiveFailures: 2,
      lastAttemptEpoch: lastAttempt,
      lastVerdict: 'fail',
    })
    const result = cooldownDecision(entry, now)
    expect(result.action).toBe('cooldown')
    if (result.action === 'cooldown') {
      expect(result.untilEpoch).toBe(lastAttempt + BACKOFF_SECONDS[2])
      expect(result.untilEpoch).toBe(lastAttempt + 14400)
    }
  })

  it('cf=3 within 86400s → cooldown', () => {
    const lastAttempt = now - 100
    const entry = makeEntry({
      consecutiveFailures: 3,
      lastAttemptEpoch: lastAttempt,
      lastVerdict: 'fail',
    })
    const result = cooldownDecision(entry, now)
    expect(result.action).toBe('cooldown')
    if (result.action === 'cooldown') {
      expect(result.untilEpoch).toBe(lastAttempt + BACKOFF_SECONDS[3])
      expect(result.untilEpoch).toBe(lastAttempt + 86400)
    }
  })

  it('cf=ATTEMPT_CAP → capped', () => {
    const entry = makeEntry({ consecutiveFailures: ATTEMPT_CAP, lastVerdict: 'fail' })
    expect(cooldownDecision(entry, now)).toEqual({ action: 'capped' })
  })

  it('cf>ATTEMPT_CAP → capped', () => {
    const entry = makeEntry({ consecutiveFailures: ATTEMPT_CAP + 2, lastVerdict: 'fail' })
    expect(cooldownDecision(entry, now)).toEqual({ action: 'capped' })
  })
})

// ── recordResult ───────────────────────────────────────────────────────────────

describe('recordResult', () => {
  const now = 1_700_200_000

  it('ok result → cf=0, verdict ok', () => {
    const entry = recordResult(null, 'ok', now)
    expect(entry.consecutiveFailures).toBe(0)
    expect(entry.lastVerdict).toBe('ok')
    expect(entry.lastAttemptEpoch).toBe(now)
    expect(entry.lastFailureReason).toBeUndefined()
  })

  it('ok result with prior failures resets consecutiveFailures', () => {
    const prior = makeEntry({ consecutiveFailures: 3, lastVerdict: 'fail' })
    const entry = recordResult(prior, 'ok', now)
    expect(entry.consecutiveFailures).toBe(0)
    expect(entry.lastVerdict).toBe('ok')
  })

  it('fail result with null prior → cf=1', () => {
    const entry = recordResult(null, 'fail', now, { reason: 'link error' })
    expect(entry.consecutiveFailures).toBe(1)
    expect(entry.lastVerdict).toBe('fail')
    expect(entry.lastFailureReason).toBe('link error')
  })

  it('fail result increments consecutiveFailures', () => {
    const prior = makeEntry({ consecutiveFailures: 2, lastVerdict: 'fail' })
    const entry = recordResult(prior, 'fail', now, { reason: 'another error' })
    expect(entry.consecutiveFailures).toBe(3)
    expect(entry.lastVerdict).toBe('fail')
  })

  it('fail reason is capped to 200 chars', () => {
    const longReason = 'x'.repeat(300)
    const entry = recordResult(null, 'fail', now, { reason: longReason })
    expect(entry.lastFailureReason).toHaveLength(200)
  })

  it('ok after failures resets cf and clears reason', () => {
    const prior = makeEntry({
      consecutiveFailures: 3,
      lastVerdict: 'fail',
      lastFailureReason: 'old error',
    })
    const entry = recordResult(prior, 'ok', now)
    expect(entry.consecutiveFailures).toBe(0)
    expect(entry.lastVerdict).toBe('ok')
    expect(entry.lastFailureReason).toBeUndefined()
  })

  it('module/abi opts are included in the entry', () => {
    const entry = recordResult(null, 'ok', now, { module: 'better-sqlite3', abi: '115' })
    expect(entry.lastModule).toBe('better-sqlite3')
    expect(entry.priorAbi).toBe('115')
  })
})

// ── writeEntry / readState / readEntry ────────────────────────────────────────

describe('writeEntry / readState / readEntry', () => {
  it('roundtrip: written entry is readable', () => {
    const path = makeTmpStatePath()
    const entry = makeEntry({
      consecutiveFailures: 1,
      lastVerdict: 'fail',
      lastFailureReason: 'test',
    })
    writeEntry('mykey', entry, path)
    expect(readEntry('mykey', path)).toEqual(entry)
  })

  it('writeEntry preserves other keys', () => {
    const path = makeTmpStatePath()
    const e1 = makeEntry({ consecutiveFailures: 0 })
    const e2 = makeEntry({ consecutiveFailures: 2, lastVerdict: 'fail' })
    writeEntry('key1', e1, path)
    writeEntry('key2', e2, path)
    // Re-read both
    expect(readEntry('key1', path)).toEqual(e1)
    expect(readEntry('key2', path)).toEqual(e2)
  })

  it('readState returns {} for missing file', () => {
    const d = tmpDir()
    const path = join(d, 'nonexistent.state')
    expect(readState(path)).toEqual({})
  })

  it('readState returns {} for corrupt JSON', () => {
    const d = tmpDir()
    const path = join(d, 'corrupt.state')
    writeFileSync(path, 'NOT JSON{{{{', 'utf8')
    expect(readState(path)).toEqual({})
  })

  it('readEntry returns null for missing key', () => {
    const d = tmpDir()
    const path = join(d, 'test.state')
    writeEntry('keyA', makeEntry(), path)
    expect(readEntry('keyB', path)).toBeNull()
  })

  it('atomic write: tmp file is cleaned up (renamed over)', () => {
    const path = makeTmpStatePath()
    writeEntry('k', makeEntry(), path)
    // No tmp files should remain after the atomic write (temp + rename)
    const dir = path.replace(/\/[^/]+$/, '')
    const files = existsSync(dir) ? readdirSync(dir) : []
    const basename = path.replace(/.*\//, '')
    expect(files.some((f) => f.startsWith(basename) && f.includes('.tmp.'))).toBe(false)
  })
})

// ── renderAutohealBanner ──────────────────────────────────────────────────────

describe('renderAutohealBanner', () => {
  const now = new Date(1_700_000_000_000) // a fixed date
  const logPath = '/tmp/test-autoheal.log'

  it('null entry → first-run sentinel containing DISABLE var verbatim', () => {
    const banner = renderAutohealBanner(null, { now, logPath })
    expect(banner).toContain('first run launched')
    expect(banner).toContain(`${AUTOHEAL_DISABLE_VAR}=1`)
  })

  it('fail entry within cap → contains "failed:" + disable var, NO "reset:"', () => {
    const entry = makeEntry({
      consecutiveFailures: 1,
      lastVerdict: 'fail',
      lastFailureReason: 'toolchain error',
      lastAttemptEpoch: Math.floor(now.getTime() / 1000) - 60,
    })
    const banner = renderAutohealBanner(entry, { now, logPath })
    expect(banner).toContain('failed:')
    expect(banner).toContain(`${AUTOHEAL_DISABLE_VAR}=1`)
    expect(banner).not.toContain('reset:')
  })

  it('fail entry at attempt cap → "cooling down (attempt cap reached)" + "reset: rm" + disable var', () => {
    const entry = makeEntry({
      consecutiveFailures: ATTEMPT_CAP,
      lastVerdict: 'fail',
      lastFailureReason: 'persistent failure',
      lastAttemptEpoch: Math.floor(now.getTime() / 1000) - 3600,
    })
    const banner = renderAutohealBanner(entry, { now, logPath })
    expect(banner).toContain('cooling down (attempt cap reached)')
    expect(banner).toContain('reset: rm ')
    expect(banner).toContain(`${AUTOHEAL_DISABLE_VAR}=1`)
  })

  it('ok entry → "[autoheal] launched" + disable var', () => {
    const entry = makeEntry({ consecutiveFailures: 0, lastVerdict: 'ok' })
    const banner = renderAutohealBanner(entry, { now, logPath })
    expect(banner).toContain('[autoheal] launched')
    expect(banner).toContain(`${AUTOHEAL_DISABLE_VAR}=1`)
  })

  it('home-dir paths render with ~ when HOME is not overridden', () => {
    const saved = process.env.SKILLSMITH_AUTOHEAL_HOME
    try {
      delete process.env.SKILLSMITH_AUTOHEAL_HOME
      // At cap, the banner embeds resolveAutohealStatePath() which uses HOME
      const entry = makeEntry({
        consecutiveFailures: ATTEMPT_CAP,
        lastVerdict: 'fail',
        lastFailureReason: 'test',
        lastAttemptEpoch: Math.floor(now.getTime() / 1000),
      })
      const homeLogPath = join(homedir(), '.skillsmith', 'logs', 'test.log')
      const banner = renderAutohealBanner(entry, { now, logPath: homeLogPath })
      // Both the log path and state path should be displayed with ~
      expect(banner).toContain('~/')
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_AUTOHEAL_HOME = saved
      else delete process.env.SKILLSMITH_AUTOHEAL_HOME
    }
  })

  it('timestamp format is YYYY-MM-DD HH:MM', () => {
    const entry = makeEntry({
      consecutiveFailures: 1,
      lastVerdict: 'fail',
      lastFailureReason: 'error',
      lastAttemptEpoch: Math.floor(now.getTime() / 1000),
    })
    const banner = renderAutohealBanner(entry, { now, logPath })
    // Expect a timestamp like "2023-11-14 22:13" in the banner
    expect(banner).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})

// ── resolveAutohealStateDir ────────────────────────────────────────────────────

describe('resolveAutohealStateDir', () => {
  it('honors SKILLSMITH_AUTOHEAL_HOME when set', () => {
    const saved = process.env.SKILLSMITH_AUTOHEAL_HOME
    const testHome = '/tmp/autoheal-test-home'
    try {
      process.env.SKILLSMITH_AUTOHEAL_HOME = testHome
      expect(resolveAutohealStateDir()).toBe(join(testHome, '.skillsmith'))
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_AUTOHEAL_HOME = saved
      else delete process.env.SKILLSMITH_AUTOHEAL_HOME
    }
  })

  it('falls back to HOME/.skillsmith when SKILLSMITH_AUTOHEAL_HOME is unset', () => {
    const saved = process.env.SKILLSMITH_AUTOHEAL_HOME
    try {
      delete process.env.SKILLSMITH_AUTOHEAL_HOME
      expect(resolveAutohealStateDir()).toBe(join(homedir(), '.skillsmith'))
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_AUTOHEAL_HOME = saved
      else delete process.env.SKILLSMITH_AUTOHEAL_HOME
    }
  })
})

// ── resolveMainRepoKey ────────────────────────────────────────────────────────

describe('resolveMainRepoKey', () => {
  it('returns the repo root for a git-init fixture', () => {
    const root = makeFixtureTempDir('autoheal-repo-test')
    tmpDirs.push(root)
    const env = makeFixtureEnv()
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', root], { env })
    // After git init, worktree list --porcelain should show `worktree <root>`
    const key = resolveMainRepoKey(root)
    expect(key).toBeTruthy()
    // The key is the canonical absolute path of the repo root.
    // On macOS, realpath may differ from the mkdtemp path (/private/var/... vs /var/...)
    // so we just check that it ends with the random suffix portion.
    expect(key).toContain('autoheal-repo-test')
  })

  it('returns null for a non-repo directory', () => {
    const nonRepo = makeFixtureTempDir('autoheal-non-repo')
    tmpDirs.push(nonRepo)
    // No git init — not a repo
    expect(resolveMainRepoKey(nonRepo)).toBeNull()
  })

  it('returns null when cwd does not exist', () => {
    expect(resolveMainRepoKey('/nonexistent/path/that/does/not/exist')).toBeNull()
  })
})
