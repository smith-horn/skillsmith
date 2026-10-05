/**
 * SMI-5432 W0.2 — unit tests for the shared liveness-alert state module.
 *
 * All filesystem writes go to unique per-test tmp paths; SKILLSMITH_LIVENESS_HOME
 * isolates any calls that hit the default state path. Never touches the real
 * ~/.skillsmith state. SKILLSMITH_LIVENESS_HOME is saved and restored around
 * each test that changes it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  LIVENESS_DISABLE_VAR,
  RENOTIFY_SECONDS,
  alertDecision,
  readEntry,
  readEntryResult,
  readState,
  recordAlert,
  recordCheck,
  renderLivenessBanner,
  resolveLivenessLogPath,
  resolveLivenessStateDir,
  writeEntry,
  type LivenessEntry,
} from './liveness-state.js'
import type { StateReadResult } from './state-read.js'
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

/** Wraps a `LivenessEntry` as the `ok` variant of `StateReadResult` — `renderLivenessBanner`'s new input shape (SMI-6995). */
function okResult(entry: LivenessEntry): StateReadResult<LivenessEntry> {
  return { status: 'ok', entry }
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

// ── readEntryResult ────────────────────────────────────────────────────────────
// SMI-6995: the consumer-axis reader. The validator is the load-bearing part —
// a `typeof` spot-check would accept `{lastVerdict: "banana"}` as `ok`
// (plan-review finding 1), so every field below is exercised individually,
// including the three optional ones, both absent (valid) and present-but-wrong-
// shape (invalid).

describe('readEntryResult', () => {
  it('a fully valid entry round-trips as ok', () => {
    const path = makeTmpStatePath()
    const entry = makeStaleEntry({ lastAlertEpoch: 1_700_000_500, openIssueNumber: 7 })
    writeEntry('repo-key', entry, path)
    expect(readEntryResult('repo-key', path)).toEqual({ status: 'ok', entry })
  })

  it('a valid entry with all optional fields omitted round-trips as ok', () => {
    const path = makeTmpStatePath()
    const entry: LivenessEntry = {
      lastCheckEpoch: 1_700_000_000,
      lastVerdict: 'healthy',
      consecutiveStale: 0,
    }
    writeEntry('repo-key', entry, path)
    expect(readEntryResult('repo-key', path)).toEqual({ status: 'ok', entry })
  })

  it('missing file → missing', () => {
    const path = join(tmpDir(), 'nonexistent.state')
    expect(readEntryResult('repo-key', path)).toEqual({ status: 'missing' })
  })

  it('valid file, absent key → missing', () => {
    const path = makeTmpStatePath()
    writeEntry('other-key', makeStaleEntry(), path)
    expect(readEntryResult('repo-key', path)).toEqual({ status: 'missing' })
  })

  it('lastVerdict outside the literal union → malformed, detail names the field (the banana case, SMI-6995 finding 1)', () => {
    // Every OTHER required field is valid here so this isolates the
    // lastVerdict check specifically — a spot-check that merely confirmed
    // "lastVerdict is a string" would accept 'banana' and read this as ok.
    const path = makeTmpStatePath()
    writeFileSync(
      path,
      `${JSON.stringify({
        'repo-key': { lastCheckEpoch: 1, lastVerdict: 'banana', consecutiveStale: 0 },
      })}\n`,
      'utf8'
    )
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('lastVerdict')
  })

  it('lastCheckEpoch non-finite (NaN via JSON string) → malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(
      path,
      `${JSON.stringify({
        'repo-key': { lastCheckEpoch: 'not-a-number', lastVerdict: 'healthy', consecutiveStale: 0 },
      })}\n`,
      'utf8'
    )
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('lastCheckEpoch')
  })

  it('consecutiveStale missing entirely → malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(
      path,
      `${JSON.stringify({ 'repo-key': { lastCheckEpoch: 1, lastVerdict: 'healthy' } })}\n`,
      'utf8'
    )
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('consecutiveStale')
  })

  it('lastStaleSinceTs present but a number (not string or null) → malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(
      path,
      `${JSON.stringify({
        'repo-key': {
          lastCheckEpoch: 1,
          lastVerdict: 'stale',
          consecutiveStale: 1,
          lastStaleSinceTs: 12345,
        },
      })}\n`,
      'utf8'
    )
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('lastStaleSinceTs')
  })

  it('lastAlertEpoch present but non-finite → malformed', () => {
    // JSON has no NaN/Infinity literal, so the wrong-shape value here is a
    // string ("nope") written as raw bytes rather than via JSON.stringify
    // (which would need a number — `Number.NaN` serializes to `null`,
    // exercising the undefined/null short-circuit instead of the
    // finite-number guard this test targets).
    const path = makeTmpStatePath()
    writeFileSync(
      path,
      '{"repo-key":{"lastCheckEpoch":1,"lastVerdict":"stale","consecutiveStale":1,"lastAlertEpoch":"nope"}}\n',
      'utf8'
    )
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('lastAlertEpoch')
  })

  it('openIssueNumber present but non-finite → malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(
      path,
      '{"repo-key":{"lastCheckEpoch":1,"lastVerdict":"stale","consecutiveStale":1,"openIssueNumber":"nope"}}\n',
      'utf8'
    )
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('openIssueNumber')
  })

  it('entry value is a JSON array, not an object → malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(path, `${JSON.stringify({ 'repo-key': [] })}\n`, 'utf8')
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
  })

  it('entry value is literally JSON null → missing, not malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(path, `${JSON.stringify({ 'repo-key': null })}\n`, 'utf8')
    expect(readEntryResult('repo-key', path)).toEqual({ status: 'missing' })
  })

  it('directory standing where the file is expected → unreadable, detail carries EISDIR', () => {
    const path = join(tmpDir(), 'retrieval-liveness.state')
    mkdirSync(path, { recursive: true })
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('unreadable')
    expect(result.status === 'unreadable' && result.detail).toContain('EISDIR')
  })

  it('whole file does not parse as JSON → malformed', () => {
    const path = makeTmpStatePath()
    writeFileSync(path, 'NOT JSON{{{', 'utf8')
    const result = readEntryResult('repo-key', path)
    expect(result.status).toBe('malformed')
  })
})

// ── renderLivenessBanner ──────────────────────────────────────────────────────

describe('renderLivenessBanner', () => {
  const now = new Date(1_700_000_000_000) // fixed date for determinism
  const logPath = '/tmp/test-liveness.log'

  it('contains the disable var verbatim', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath })
    expect(banner).toContain(`${LIVENESS_DISABLE_VAR}=1`)
  })

  it('contains the log path', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath })
    expect(banner).toContain(logPath)
  })

  it('contains the staleSinceTs timestamp', () => {
    const entry = makeStaleEntry({ lastStaleSinceTs: '2026-06-01T00:00:00.000Z' })
    const banner = renderLivenessBanner(okResult(entry), { now, logPath })
    expect(banner).toContain('2026-06-01T00:00:00.000Z')
  })

  it('points at the repair script', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath })
    expect(banner).toContain('repair-host-native-deps.sh')
  })

  it('is bold markdown (opens with **[liveness]**)', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath })
    expect(banner).toMatch(/^\*\*\[liveness\]\*\*/)
  })

  it('with autohealFailed=true → contains the M2 causal phrase', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath, autohealFailed: true })
    expect(banner).toContain('likely the host auto-heal failure above')
  })

  it('with autohealFailed=false → does NOT contain the causal phrase', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath, autohealFailed: false })
    expect(banner).not.toContain('likely the host auto-heal failure above')
  })

  it('with autohealFailed omitted → does NOT contain the causal phrase', () => {
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath })
    expect(banner).not.toContain('likely the host auto-heal failure above')
  })

  it('ok + healthy entry → health-unknown fallback containing disable var (pre-SMI-6995 behaviour, preserved)', () => {
    const healthy: LivenessEntry = {
      lastCheckEpoch: 1_700_000_000,
      lastVerdict: 'healthy',
      lastStaleSinceTs: null,
      consecutiveStale: 0,
    }
    const banner = renderLivenessBanner(okResult(healthy), { now, logPath })
    expect(banner).toContain(LIVENESS_DISABLE_VAR)
    expect(banner).toContain('unknown')
  })

  it('home-dir log paths collapse to ~/ (displayPath)', () => {
    const homeLogPath = join(homedir(), '.skillsmith', 'logs', 'test.log')
    const entry = makeStaleEntry()
    const banner = renderLivenessBanner(okResult(entry), { now, logPath: homeLogPath })
    expect(banner).toContain('~/')
    // The raw home dir string must not appear verbatim in the banner.
    expect(banner).not.toContain(homedir())
  })

  // SMI-6995: the two cases this module never had — a corrupt/unreadable
  // state file must render SOMETHING naming the fault, and a genuinely
  // absent file must stay silent, asserted together against the SAME path
  // and the SAME reader so the absence half can't pass just because nothing
  // ran (CLAUDE.md's negative-assertion-needs-paired-execution-proof rule).

  it('malformed file: readEntryResult → malformed, banner non-empty and names it; missing file (same path, same reader) → status missing, banner empty', () => {
    const dir = tmpDir()
    const path = join(dir, 'retrieval-liveness.state')

    // --- missing half, asserted first against a path nothing has touched yet ---
    const missingRead = readEntryResult('repo-key', path)
    expect(missingRead.status).toBe('missing')
    expect(renderLivenessBanner(missingRead, { now, logPath })).toBe('')

    // --- malformed half, same path, same reader ---
    writeFileSync(path, 'NOT JSON{{{', 'utf8')
    const malformedRead = readEntryResult('repo-key', path)
    expect(malformedRead.status).toBe('malformed')
    const banner = renderLivenessBanner(malformedRead, { now, logPath })
    expect(banner).not.toBe('')
    expect(banner).toContain('malformed')
    expect(banner).toContain(LIVENESS_DISABLE_VAR)
  })

  it('unreadable (directory standing in place of the file): readEntryResult → unreadable, banner names the errno', () => {
    const dir = tmpDir()
    const path = join(dir, 'retrieval-liveness.state')
    // chmod is a no-op under root (this container runs as root) — a directory
    // standing where the file is expected throws EISDIR at any uid, which is
    // how state-read.ts's own unreadable tests simulate this, and the only
    // way that reliably exercises this branch here too.
    mkdirSync(path, { recursive: true })

    const read = readEntryResult('repo-key', path)
    expect(read.status).toBe('unreadable')
    const detail = read.status === 'unreadable' ? read.detail : ''
    expect(detail).toContain('EISDIR')

    const banner = renderLivenessBanner(read, { now, logPath })
    expect(banner).not.toBe('')
    expect(banner).toContain('unreadable')
    expect(banner).toContain(detail)
  })

  it('valid JSON, invalid entry ({lastVerdict: "banana"}): readEntryResult → malformed, banner non-empty', () => {
    const dir = tmpDir()
    const path = join(dir, 'retrieval-liveness.state')
    writeFileSync(path, `${JSON.stringify({ 'repo-key': { lastVerdict: 'banana' } })}\n`, 'utf8')

    const read = readEntryResult('repo-key', path)
    expect(read.status).toBe('malformed')

    const banner = renderLivenessBanner(read, { now, logPath })
    expect(banner).not.toBe('')
    expect(banner).toContain('malformed')
  })
})
