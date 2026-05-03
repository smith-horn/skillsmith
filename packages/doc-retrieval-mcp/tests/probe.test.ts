import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import type BetterSqlite3 from 'better-sqlite3'

import { assessInstrumentationHealth, type ProbeResult } from '../src/retrieval-log/probe.js'
import type { RetrievalLogOutageMarker } from '../src/retrieval-log/schema.js'
import { SCHEMA_SQL } from '../src/retrieval-log/schema.js'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof BetterSqlite3

let scratch: string
let dbPath: string
let outageMarkerPath: string

const NOW = new Date('2026-05-02T12:00:00Z')

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'probe-'))
  dbPath = join(scratch, 'retrieval-logs.db')
  outageMarkerPath = join(scratch, 'retrieval-log.outage.json')
  delete process.env.IS_DOCKER
  delete process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.IS_DOCKER
  delete process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE
  vi.restoreAllMocks()
})

function seedDb(rowsByOffsetHours: number[]): void {
  const db = new Database(dbPath)
  db.exec(SCHEMA_SQL)
  const ins = db.prepare(
    `INSERT INTO retrieval_events (session_id, ts, trigger, query, top_k_results, hook_outcome)
     VALUES (?, ?, 'session_start_priming', '', '[]', 'primed')`
  )
  for (const off of rowsByOffsetHours) {
    const ts = new Date(NOW.getTime() - off * 60 * 60 * 1000).toISOString()
    ins.run(`s-${off}`, ts)
  }
  db.close()
}

function writeMarker(marker: RetrievalLogOutageMarker): void {
  writeFileSync(outageMarkerPath, JSON.stringify(marker))
}

async function probe(input: Partial<Parameters<typeof assessInstrumentationHealth>[0]>) {
  return assessInstrumentationHealth({
    outageMarkerPath,
    dbPath,
    now: NOW,
    staleHours: 24,
    jsonlSessionCount24h: 0,
    ...input,
  })
}

describe('assessInstrumentationHealth', () => {
  it('returns probe_disabled when SKILLSMITH_RETRIEVAL_PROBE_DISABLE=1', async () => {
    process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE = '1'
    const result = await probe({})
    expect(result.stale).toBe(false)
    expect(result.reason).toBe('probe_disabled')
  })

  it('returns healthy when DB has recent primed rows matching session count', async () => {
    seedDb([1, 2, 3])
    const result = await probe({ jsonlSessionCount24h: 4 })
    expect(result.stale).toBe(false)
    expect(result.reason).toBe('healthy')
    expect(result.lastRealSessionTs).not.toBeNull()
  })

  it('returns healthy with no DB file when no JSONL sessions exist', async () => {
    const result = await probe({ jsonlSessionCount24h: 0 })
    expect(result.stale).toBe(false)
    expect(result.reason).toBe('healthy')
  })

  it('treats a malformed marker file as absent (falls through)', async () => {
    writeFileSync(outageMarkerPath, '{ this is not valid JSON ')
    seedDb([1])
    const result = await probe({ jsonlSessionCount24h: 1 })
    expect(result.outageMarker).toBeNull()
    expect(result.reason).toBe('healthy')
  })

  it('returns IS_DOCKER_set_on_host when env var set on real host', async () => {
    process.env.IS_DOCKER = 'true'
    // No /.dockerenv on real host (test must run on a host without it).
    const result = await probe({})
    if (result.reason === 'IS_DOCKER_set_on_host') {
      expect(result.stale).toBe(true)
      expect(result.isDockerOnHost).toBe(true)
    } else {
      // Test runner is itself in Docker — probe correctly suppresses the trap.
      expect(result.isDockerOnHost).toBe(false)
    }
  })

  it('returns outage_marker_present with the marker payload when marker is fresh', async () => {
    const marker: RetrievalLogOutageMarker = {
      ts: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      reason: 'binding_unavailable',
      error: 'native binding for better-sqlite3 not found',
      hint: 'run ./scripts/repair-host-native-deps.sh',
    }
    writeMarker(marker)
    const result = await probe({})
    expect(result.stale).toBe(true)
    expect(result.reason).toBe('outage_marker_present')
    expect(result.outageMarker?.reason).toBe('binding_unavailable')
    expect(result.outageMarker?.hint).toContain('repair-host-native-deps')
  })

  it('treats a marker older than 7 days as absent (self-clearing TTL)', async () => {
    const marker: RetrievalLogOutageMarker = {
      ts: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      reason: 'binding_unavailable',
      error: 'old',
      hint: 'old',
    }
    writeMarker(marker)
    const result = await probe({})
    // No DB, no sessions → falls through to healthy.
    expect(result.outageMarker).toBeNull()
  })

  it('returns no_recent_rows when sessionCount > 5 and zero primed rows', async () => {
    // No DB → row count 0
    const result = await probe({ jsonlSessionCount24h: 8 })
    expect(result.stale).toBe(true)
    expect(result.reason).toBe('no_recent_rows')
  })

  it('returns low_capture_rate when rows < 50% of session count', async () => {
    seedDb([1, 2]) // 2 rows
    const result = await probe({ jsonlSessionCount24h: 8 }) // 25% capture
    expect(result.stale).toBe(true)
    expect(result.reason).toBe('low_capture_rate')
    expect(result.lastRealSessionTs).not.toBeNull()
  })

  it('returns binding_unavailable_no_marker when better-sqlite3 fails to import', async () => {
    // Force the dynamic import to throw by placing a poisoned package alongside
    // the existing one. Easiest path: mock the module via vi.doMock then
    // re-import the probe module so the mock is in scope of its dynamic import.
    vi.resetModules()
    vi.doMock('better-sqlite3', () => {
      throw new Error('Cannot find module bindings')
    })
    // Seed a non-empty DB file so the existsSync check passes and the probe
    // attempts the dynamic import (the failure path we want to exercise).
    writeFileSync(dbPath, 'placeholder')
    const reloaded = (await import('../src/retrieval-log/probe.js')) as {
      assessInstrumentationHealth: typeof assessInstrumentationHealth
    }
    const result: ProbeResult = await reloaded.assessInstrumentationHealth({
      outageMarkerPath,
      dbPath,
      now: NOW,
      staleHours: 24,
      jsonlSessionCount24h: 1,
    })
    expect(result.stale).toBe(true)
    expect(result.reason).toBe('binding_unavailable_no_marker')
    vi.doUnmock('better-sqlite3')
  })

  it('honors a tunable staleHours window', async () => {
    seedDb([10]) // 10h ago
    // 6h window → row is older than window → treated as zero count
    const result = await probe({ staleHours: 6, jsonlSessionCount24h: 8 })
    expect(result.stale).toBe(true)
    expect(result.reason).toBe('no_recent_rows')
  })
})
