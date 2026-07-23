/**
 * SMI-5793 — unit tests for the shared reindex-observability state module.
 *
 * No mocking needed — all filesystem writes go to unique per-test tmp paths.
 * Never touches the real ~/.skillsmith state.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  ANOMALY_ZERO_TOUCH_THRESHOLD,
  DEFAULT_HUNG_STALE_HOURS,
  REINDEX_STALENESS_DISABLE_VAR,
  readEntry,
  readState,
  recordRun,
  renderReindexBanner,
  resolveReindexLogPath,
  resolveReindexStateDir,
  resolveReindexStatePath,
  writeEntry,
  type ReindexEntry,
} from './reindex-state.js'
import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpStatePath(): string {
  const dir = tmpDir()
  return join(dir, 'reindex.state')
}

function makeSuccessRun(
  overrides: Partial<Omit<ReindexEntry, 'consecutiveZeroTouchRuns'>> = {}
): Omit<ReindexEntry, 'consecutiveZeroTouchRuns'> {
  return {
    lastRunTs: '2026-07-21T12:00:00.000Z',
    lastRunSha: 'sha-a',
    mode: 'incremental',
    filesScanned: 3,
    chunksUpserted: 3,
    chunksDeleted: 0,
    durationMs: 500,
    success: true,
    ...overrides,
  }
}

function makeEntry(overrides: Partial<ReindexEntry> = {}): ReindexEntry {
  return {
    ...makeSuccessRun(),
    consecutiveZeroTouchRuns: 0,
    ...overrides,
  }
}

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
  const d = makeFixtureTempDir('reindex-state-test')
  tmpDirs.push(d)
  return d
}

// ── resolveReindexStateDir / resolveReindexStatePath / resolveReindexLogPath ─

describe('resolveReindexStateDir', () => {
  it('honors SKILLSMITH_STATE_DIR_OVERRIDE when set', () => {
    const saved = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    try {
      process.env.SKILLSMITH_STATE_DIR_OVERRIDE = '/skillsmith-state'
      expect(resolveReindexStateDir()).toBe('/skillsmith-state')
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_STATE_DIR_OVERRIDE = saved
      else delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    }
  })

  it('falls back to homedir()/.skillsmith when unset', () => {
    const saved = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    try {
      delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
      expect(resolveReindexStateDir()).toBe(join(homedir(), '.skillsmith'))
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_STATE_DIR_OVERRIDE = saved
      else delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    }
  })
})

describe('resolveReindexStatePath / resolveReindexLogPath', () => {
  it('state path is <dir>/reindex.state', () => {
    const saved = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    try {
      process.env.SKILLSMITH_STATE_DIR_OVERRIDE = '/skillsmith-state'
      expect(resolveReindexStatePath()).toBe('/skillsmith-state/reindex.state')
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_STATE_DIR_OVERRIDE = saved
      else delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    }
  })

  it('log path is <dir>/logs/skillsmith-doc-retrieval-<YYYY-MM-DD>.jsonl (local date)', () => {
    const saved = process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    try {
      process.env.SKILLSMITH_STATE_DIR_OVERRIDE = '/skillsmith-state'
      // No Z suffix so the date is parsed as LOCAL time — TZ-stable assertion.
      const p = resolveReindexLogPath(new Date('2026-06-28T12:00:00'))
      expect(p).toBe('/skillsmith-state/logs/skillsmith-doc-retrieval-2026-06-28.jsonl')
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_STATE_DIR_OVERRIDE = saved
      else delete process.env.SKILLSMITH_STATE_DIR_OVERRIDE
    }
  })
})

// ── writeEntry / readState / readEntry (atomic write, fail-soft read) ──────

describe('writeEntry / readState / readEntry', () => {
  it('roundtrip: written entry is readable', () => {
    const path = makeTmpStatePath()
    const entry = makeEntry({ consecutiveZeroTouchRuns: 2 })
    writeEntry('mykey', entry, path)
    expect(readEntry('mykey', path)).toEqual(entry)
  })

  it('writeEntry preserves other keys', () => {
    const path = makeTmpStatePath()
    const e1 = makeEntry({ lastRunSha: 'sha-1' })
    const e2 = makeEntry({ lastRunSha: 'sha-2', consecutiveZeroTouchRuns: 3 })
    writeEntry('key1', e1, path)
    writeEntry('key2', e2, path)
    expect(readEntry('key1', path)).toEqual(e1)
    expect(readEntry('key2', path)).toEqual(e2)
  })

  it('readState returns {} for missing file', () => {
    const d = tmpDir()
    const path = join(d, 'nonexistent.state')
    expect(readState(path)).toEqual({})
  })

  it('readState returns {} for corrupt JSON (fail-soft on corrupt state)', () => {
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

  it('readEntry returns null for a missing state file (fail-soft on missing state)', () => {
    const d = tmpDir()
    const path = join(d, 'missing.state')
    expect(readEntry('anykey', path)).toBeNull()
  })

  it('atomic write: no .tmp file remains after the write (temp + rename)', () => {
    const path = makeTmpStatePath()
    writeEntry('k', makeEntry(), path)
    const dir = path.replace(/\/[^/]+$/, '')
    const files = existsSync(dir) ? readdirSync(dir) : []
    const basename = path.replace(/.*\//, '')
    expect(files.some((f) => f.startsWith(basename) && f.includes('.tmp.'))).toBe(false)
  })
})

// ── recordRun — zero-touch-streak transition table ──────────────────────────

describe('recordRun', () => {
  it('real file-touch resets the streak to 0, regardless of prior streak or sha', () => {
    const prior = makeEntry({ lastRunSha: 'sha-a', consecutiveZeroTouchRuns: 7 })
    const entry = recordRun(prior, makeSuccessRun({ lastRunSha: 'sha-b', filesScanned: 2 }))
    expect(entry.consecutiveZeroTouchRuns).toBe(0)
  })

  it('a failed run resets the streak to 0 even though filesScanned/chunks are 0', () => {
    const prior = makeEntry({ lastRunSha: 'sha-a', consecutiveZeroTouchRuns: 4 })
    const entry = recordRun(
      prior,
      makeSuccessRun({
        lastRunSha: 'sha-b',
        filesScanned: 0,
        chunksUpserted: 0,
        chunksDeleted: 0,
        success: false,
        errorReason: 'boom',
      })
    )
    expect(entry.consecutiveZeroTouchRuns).toBe(0)
  })

  it('zero-touch run with an advancing sha increments the streak', () => {
    const prior = makeEntry({ lastRunSha: 'sha-a', consecutiveZeroTouchRuns: 1 })
    const entry = recordRun(
      prior,
      makeSuccessRun({
        lastRunSha: 'sha-b',
        filesScanned: 0,
        chunksUpserted: 0,
        chunksDeleted: 0,
      })
    )
    expect(entry.consecutiveZeroTouchRuns).toBe(2)
  })

  it('first-ever run (prior null) that is zero-touch does not increment (no prior sha to advance from)', () => {
    const entry = recordRun(
      null,
      makeSuccessRun({ lastRunSha: 'sha-a', filesScanned: 0, chunksUpserted: 0, chunksDeleted: 0 })
    )
    expect(entry.consecutiveZeroTouchRuns).toBe(0)
  })

  it('zero-touch run against an unchanged sha (repeat run, no new commit) holds the streak steady', () => {
    const prior = makeEntry({ lastRunSha: 'sha-a', consecutiveZeroTouchRuns: 3 })
    const entry = recordRun(
      prior,
      makeSuccessRun({
        lastRunSha: 'sha-a', // same sha as prior — no advancement
        filesScanned: 0,
        chunksUpserted: 0,
        chunksDeleted: 0,
      })
    )
    expect(entry.consecutiveZeroTouchRuns).toBe(3)
  })

  it('a chunksDeleted-only touch (files removed, none scanned) still counts as a real touch', () => {
    const prior = makeEntry({ lastRunSha: 'sha-a', consecutiveZeroTouchRuns: 5 })
    const entry = recordRun(
      prior,
      makeSuccessRun({
        lastRunSha: 'sha-b',
        filesScanned: 0,
        chunksUpserted: 0,
        chunksDeleted: 2,
      })
    )
    expect(entry.consecutiveZeroTouchRuns).toBe(0)
  })
})

// ── renderReindexBanner — five states ───────────────────────────────────────

describe('renderReindexBanner', () => {
  const now = new Date('2026-07-21T12:00:00.000Z')

  it('no entry (null) → empty string, no steady-state noise', () => {
    expect(renderReindexBanner(null, { now, currentHeadSha: 'sha-a' })).toBe('')
  })

  it('failed run → contains "last run failed:" + the error reason + disable var + log path', () => {
    const entry = makeEntry({ success: false, errorReason: 'ENOENT: vectors missing' })
    const banner = renderReindexBanner(entry, { now, currentHeadSha: 'sha-a' })
    expect(banner).toContain('[reindex]')
    expect(banner).toContain('last run failed: ENOENT: vectors missing')
    expect(banner).toContain(`${REINDEX_STALENESS_DISABLE_VAR}=1`)
    expect(banner).toContain('log:')
  })

  it('failed run with no errorReason falls back to "unknown"', () => {
    const entry = makeEntry({ success: false, errorReason: undefined })
    const banner = renderReindexBanner(entry, { now, currentHeadSha: 'sha-a' })
    expect(banner).toContain('last run failed: unknown')
  })

  it('anomaly (streak >= threshold) → names the streak count + SMI-5786 + a verify command + disable var', () => {
    const entry = makeEntry({ consecutiveZeroTouchRuns: ANOMALY_ZERO_TOUCH_THRESHOLD })
    const banner = renderReindexBanner(entry, { now, currentHeadSha: 'sha-a' })
    expect(banner).toContain(`${ANOMALY_ZERO_TOUCH_THRESHOLD} consecutive commits scanned 0 files`)
    expect(banner).toContain('SMI-5786')
    expect(banner).toContain('reindex --full')
    expect(banner).toContain(`${REINDEX_STALENESS_DISABLE_VAR}=1`)
  })

  it('streak just below threshold does NOT trigger the anomaly banner', () => {
    const entry = makeEntry({
      consecutiveZeroTouchRuns: ANOMALY_ZERO_TOUCH_THRESHOLD - 1,
      lastRunTs: now.toISOString(),
      lastRunSha: 'sha-a',
    })
    expect(renderReindexBanner(entry, { now, currentHeadSha: 'sha-a' })).toBe('')
  })

  it('hung (no run in > staleHours despite HEAD advancing) → possibly hung/not firing + docker ps hint', () => {
    const staleTs = new Date(
      now.getTime() - (DEFAULT_HUNG_STALE_HOURS + 1) * 3_600_000
    ).toISOString()
    const entry = makeEntry({ lastRunTs: staleTs, lastRunSha: 'sha-old' })
    const banner = renderReindexBanner(entry, { now, currentHeadSha: 'sha-new' })
    expect(banner).toContain('possibly hung or not firing')
    expect(banner).toContain('docker ps')
    expect(banner).toContain(`${REINDEX_STALENESS_DISABLE_VAR}=1`)
  })

  it('respects a custom staleHours override', () => {
    const staleTs = new Date(now.getTime() - 2 * 3_600_000).toISOString()
    const entry = makeEntry({ lastRunTs: staleTs, lastRunSha: 'sha-old' })
    const banner = renderReindexBanner(entry, {
      now,
      currentHeadSha: 'sha-new',
      staleHours: 1,
    })
    expect(banner).toContain('possibly hung or not firing')
  })

  it('does NOT flag hung when currentHeadSha matches lastRunSha (nothing new to have missed)', () => {
    const staleTs = new Date(
      now.getTime() - (DEFAULT_HUNG_STALE_HOURS + 1) * 3_600_000
    ).toISOString()
    const entry = makeEntry({ lastRunTs: staleTs, lastRunSha: 'sha-same' })
    expect(renderReindexBanner(entry, { now, currentHeadSha: 'sha-same' })).toBe('')
  })

  it('does NOT flag hung when currentHeadSha is null (detached/shallow edge state)', () => {
    const staleTs = new Date(
      now.getTime() - (DEFAULT_HUNG_STALE_HOURS + 1) * 3_600_000
    ).toISOString()
    const entry = makeEntry({ lastRunTs: staleTs, lastRunSha: 'sha-old' })
    expect(renderReindexBanner(entry, { now, currentHeadSha: null })).toBe('')
  })

  it('healthy/silent (recent run, no anomaly, no hung state) → empty string', () => {
    const entry = makeEntry({
      success: true,
      consecutiveZeroTouchRuns: 0,
      lastRunTs: now.toISOString(),
      lastRunSha: 'sha-a',
    })
    expect(renderReindexBanner(entry, { now, currentHeadSha: 'sha-a' })).toBe('')
  })
})
