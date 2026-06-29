/**
 * SMI-5432 W0.2 — unit tests for the shared liveness-alert state module.
 *
 * All filesystem writes go to unique per-test tmp paths; SKILLSMITH_LIVENESS_HOME
 * isolates any calls that hit the default state path. Never touches the real
 * ~/.skillsmith state. SKILLSMITH_LIVENESS_HOME is saved and restored around
 * each test that changes it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  LIVENESS_DISABLE_VAR,
  RENOTIFY_SECONDS,
  alertDecision,
  readEntry,
  readState,
  recordAlert,
  recordCheck,
  renderLivenessBanner,
  resolveLivenessLogPath,
  resolveLivenessStateDir,
  writeEntry,
  type LivenessEntry,
} from './liveness-state.js'
import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  const d = makeFixtureTempDir('liveness-state-test')
  tmpDirs.push(d)
  return d
}

/** Create a unique tmp state file path that never touches ~/.skillsmith. */
function makeTmpStatePath(): string {
  return join(tmpDir(), 'retrieval-liveness.state')
}

function makeStaleEntry(overrides: Partial<LivenessEntry> = {}): LivenessEntry {
  return {
    lastCheckEpoch: 1_700_000_000,
    lastVerdict: 'stale',
    lastStaleSinceTs: '2026-06-01T00:00:00.000Z',
    consecutiveStale: 1,
    ...overrides,
  }
}

// ── resolveLivenessLogPath ─────────────────────────────────────────────────────

describe('resolveLivenessLogPath', () => {
  it('returns a per-day log path under the state dir (YYYY-MM-DD, local)', () => {
    // Date string without Z is parsed as LOCAL time, so the day is TZ-stable.
    const p = resolveLivenessLogPath(new Date('2026-06-28T12:00:00'))
    expect(p).toContain('.skillsmith')
    expect(p).toMatch(/retrieval-liveness-2026-06-28\.log$/)
  })
})

// ── resolveLivenessStateDir ───────────────────────────────────────────────────

describe('resolveLivenessStateDir', () => {
  it('honors SKILLSMITH_LIVENESS_HOME when set', () => {
    const testHome = tmpDir()
    const saved = process.env.SKILLSMITH_LIVENESS_HOME
    try {
      process.env.SKILLSMITH_LIVENESS_HOME = testHome
      expect(resolveLivenessStateDir()).toBe(join(testHome, '.skillsmith'))
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_LIVENESS_HOME = saved
      else delete process.env.SKILLSMITH_LIVENESS_HOME
    }
  })

  it('falls back to HOME/.skillsmith when SKILLSMITH_LIVENESS_HOME is unset', () => {
    const saved = process.env.SKILLSMITH_LIVENESS_HOME
    try {
      delete process.env.SKILLSMITH_LIVENESS_HOME
      expect(resolveLivenessStateDir()).toBe(join(homedir(), '.skillsmith'))
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_LIVENESS_HOME = saved
      else delete process.env.SKILLSMITH_LIVENESS_HOME
    }
  })
})

// ── recordCheck ────────────────────────────────────────────────────────────────

describe('recordCheck', () => {
  const now = 1_700_200_000

  it('healthy verdict resets consecutiveStale to 0 and clears lastStaleSinceTs', () => {
    const prior = makeStaleEntry({ consecutiveStale: 3 })
    const entry = recordCheck(prior, 'healthy', now)
    expect(entry.lastVerdict).toBe('healthy')
    expect(entry.consecutiveStale).toBe(0)
    expect(entry.lastStaleSinceTs).toBeNull()
    expect(entry.lastCheckEpoch).toBe(now)
  })

  it('healthy from null prior → consecutiveStale=0, lastStaleSinceTs null', () => {
    const entry = recordCheck(null, 'healthy', now)
    expect(entry.consecutiveStale).toBe(0)
    expect(entry.lastVerdict).toBe('healthy')
    expect(entry.lastStaleSinceTs).toBeNull()
  })

  it('healthy clears alert fields so a fresh stale cycle notifies again', () => {
    const prior = makeStaleEntry({ lastAlertEpoch: 1_700_100_000, openIssueNumber: 77 })
    const entry = recordCheck(prior, 'healthy', now)
    expect(entry.lastAlertEpoch).toBeUndefined()
    expect(entry.openIssueNumber).toBeUndefined()
  })

  it('stale verdict increments consecutiveStale', () => {
    const prior = makeStaleEntry({ consecutiveStale: 2 })
    const entry = recordCheck(prior, 'stale', now)
    expect(entry.consecutiveStale).toBe(3)
    expect(entry.lastVerdict).toBe('stale')
    expect(entry.lastCheckEpoch).toBe(now)
  })

  it('stale from null prior → consecutiveStale=1 and captures staleSinceTs from opts', () => {
    const entry = recordCheck(null, 'stale', now, { staleSinceTs: '2026-06-01T00:00:00.000Z' })
    expect(entry.consecutiveStale).toBe(1)
    expect(entry.lastStaleSinceTs).toBe('2026-06-01T00:00:00.000Z')
  })

  it('stale sets lastStaleSinceTs only on first detection — preserves original', () => {
    // Already has a staleSince timestamp: a later stale opts value must be ignored.
    const prior = makeStaleEntry({
      consecutiveStale: 1,
      lastStaleSinceTs: '2026-05-01T00:00:00.000Z',
    })
    const entry = recordCheck(prior, 'stale', now, { staleSinceTs: '2026-06-01T00:00:00.000Z' })
    expect(entry.lastStaleSinceTs).toBe('2026-05-01T00:00:00.000Z')
  })

  it('stale from null prior with no opts → lastStaleSinceTs is null', () => {
    const entry = recordCheck(null, 'stale', now)
    expect(entry.lastStaleSinceTs).toBeNull()
  })

  it('stale preserves lastAlertEpoch and openIssueNumber from prior', () => {
    const prior = makeStaleEntry({ lastAlertEpoch: 1_699_000_000, openIssueNumber: 42 })
    const entry = recordCheck(prior, 'stale', now)
    expect(entry.lastAlertEpoch).toBe(1_699_000_000)
    expect(entry.openIssueNumber).toBe(42)
  })
})

// ── alertDecision ──────────────────────────────────────────────────────────────

describe('alertDecision', () => {
  const baseEpoch = 1_700_000_000

  it('null entry → dedupe', () => {
    expect(alertDecision(null, baseEpoch)).toBe('dedupe')
  })

  it('healthy entry → dedupe', () => {
    const entry: LivenessEntry = {
      lastCheckEpoch: baseEpoch,
      lastVerdict: 'healthy',
      consecutiveStale: 0,
    }
    expect(alertDecision(entry, baseEpoch)).toBe('dedupe')
  })

  it('first stale with no lastAlertEpoch → notify', () => {
    const entry = makeStaleEntry()
    expect(alertDecision(entry, baseEpoch)).toBe('notify')
  })

  it('second stale within 14-day cooldown → dedupe', () => {
    const alertedAt = baseEpoch - 3600 // 1 hour ago, well within 14 days
    const entry = makeStaleEntry({ lastAlertEpoch: alertedAt })
    expect(alertDecision(entry, baseEpoch)).toBe('dedupe')
  })

  it('stale after 14-day cooldown elapsed → notify again', () => {
    const alertedAt = baseEpoch - RENOTIFY_SECONDS - 1
    const entry = makeStaleEntry({ lastAlertEpoch: alertedAt })
    expect(alertDecision(entry, baseEpoch)).toBe('notify')
  })

  it('stale exactly at boundary (one second inside cooldown) → dedupe', () => {
    const alertedAt = baseEpoch - RENOTIFY_SECONDS + 1
    const entry = makeStaleEntry({ lastAlertEpoch: alertedAt })
    expect(alertDecision(entry, baseEpoch)).toBe('dedupe')
  })

  it('stale exactly at RENOTIFY_SECONDS boundary → notify (>= semantics)', () => {
    const alertedAt = baseEpoch - RENOTIFY_SECONDS
    const entry = makeStaleEntry({ lastAlertEpoch: alertedAt })
    expect(alertDecision(entry, baseEpoch)).toBe('notify')
  })
})

// ── recordAlert ────────────────────────────────────────────────────────────────

describe('recordAlert', () => {
  const now = 1_700_300_000

  it('sets lastAlertEpoch to nowEpoch', () => {
    const entry = makeStaleEntry()
    const updated = recordAlert(entry, now)
    expect(updated.lastAlertEpoch).toBe(now)
  })

  it('sets openIssueNumber when provided', () => {
    const entry = makeStaleEntry()
    const updated = recordAlert(entry, now, 42)
    expect(updated.openIssueNumber).toBe(42)
  })

  it('does not set openIssueNumber when not provided', () => {
    const entry = makeStaleEntry()
    const updated = recordAlert(entry, now)
    expect(updated.openIssueNumber).toBeUndefined()
  })

  it('preserves all other fields from the entry', () => {
    const entry = makeStaleEntry({
      consecutiveStale: 5,
      lastStaleSinceTs: '2026-05-01T00:00:00.000Z',
    })
    const updated = recordAlert(entry, now, 99)
    expect(updated.consecutiveStale).toBe(5)
    expect(updated.lastVerdict).toBe('stale')
    expect(updated.lastStaleSinceTs).toBe('2026-05-01T00:00:00.000Z')
    expect(updated.openIssueNumber).toBe(99)
  })
})

// ── writeEntry / readState / readEntry ────────────────────────────────────────

describe('writeEntry / readState / readEntry', () => {
  it('round-trip: written entry is readable', () => {
    const path = makeTmpStatePath()
    const entry = makeStaleEntry({ consecutiveStale: 2 })
    writeEntry('mykey', entry, path)
    expect(readEntry('mykey', path)).toEqual(entry)
  })

  it('writeEntry preserves other keys (key-preserving merge)', () => {
    const path = makeTmpStatePath()
    const e1 = makeStaleEntry({ consecutiveStale: 1 })
    const e2: LivenessEntry = {
      lastCheckEpoch: 1_700_000_001,
      lastVerdict: 'healthy',
      lastStaleSinceTs: null,
      consecutiveStale: 0,
    }
    writeEntry('keyA', e1, path)
    writeEntry('keyB', e2, path)
    // Writing key B must not clobber key A
    expect(readEntry('keyA', path)).toEqual(e1)
    expect(readEntry('keyB', path)).toEqual(e2)
  })

  it('readState returns {} for missing file (fail-soft)', () => {
    const path = join(tmpDir(), 'nonexistent.state')
    expect(readState(path)).toEqual({})
  })

  it('readState returns {} for corrupt JSON (fail-soft)', () => {
    const dir = tmpDir()
    const path = join(dir, 'corrupt.state')
    writeFileSync(path, 'NOT JSON{{{{', 'utf8')
    expect(readState(path)).toEqual({})
  })

  it('readEntry returns null for a key that does not exist', () => {
    const path = makeTmpStatePath()
    writeEntry('keyA', makeStaleEntry(), path)
    expect(readEntry('keyB', path)).toBeNull()
  })
})

// ── renderLivenessBanner ──────────────────────────────────────────────────────

describe('renderLivenessBanner', () => {
  const now = new Date(1_700_000_000_000) // fixed date for determinism
  const logPath = '/tmp/test-liveness.log'

  it('contains the disable var verbatim', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath })
    expect(banner).toContain(`${LIVENESS_DISABLE_VAR}=1`)
  })

  it('contains the log path', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath })
    expect(banner).toContain(logPath)
  })

  it('contains the staleSinceTs timestamp', () => {
    const entry = makeStaleEntry({ lastStaleSinceTs: '2026-06-01T00:00:00.000Z' })
    const banner = renderLivenessBanner(entry, { now, logPath })
    expect(banner).toContain('2026-06-01T00:00:00.000Z')
  })

  it('points at the repair script', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath })
    expect(banner).toContain('repair-host-native-deps.sh')
  })

  it('is bold markdown (opens with **[liveness]**)', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath })
    expect(banner).toMatch(/^\*\*\[liveness\]\*\*/)
  })

  it('with autohealFailed=true → contains the M2 causal phrase', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath, autohealFailed: true })
    expect(banner).toContain('likely the host auto-heal failure above')
  })

  it('with autohealFailed=false → does NOT contain the causal phrase', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath, autohealFailed: false })
    expect(banner).not.toContain('likely the host auto-heal failure above')
  })

  it('with autohealFailed omitted → does NOT contain the causal phrase', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath })
    expect(banner).not.toContain('likely the host auto-heal failure above')
  })

  it('null entry → health-unknown fallback containing disable var', () => {
    const banner = renderLivenessBanner(null, { now, logPath })
    expect(banner).toContain(LIVENESS_DISABLE_VAR)
    expect(banner).toContain('unknown')
  })

  it('home-dir log paths collapse to ~/ (displayPath)', () => {
    const homeLogPath = join(homedir(), '.skillsmith', 'logs', 'test.log')
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(entry, { now, logPath: homeLogPath })
    expect(banner).toContain('~/')
    // The raw home dir string must not appear verbatim in the banner.
    expect(banner).not.toContain(homedir())
  })
})
