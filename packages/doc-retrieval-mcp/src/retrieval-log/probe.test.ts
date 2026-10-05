/**
 * SMI-6995 — unit tests for the outage-marker five-way classification in
 * `probe.ts` (`readOutageMarker`, exported for exactly this purpose), plus
 * the `outageMarkerRead` field it feeds on `ProbeResult` via
 * `assessInstrumentationHealth`.
 *
 * This module is the worst of the SMI-6995 sweep precisely because absence
 * is the HEALTHY state here: the pre-fix `readOutageMarker` returned `null`
 * for "never written", "expired", AND "present but corrupt" alike, and that
 * `null` rendered in the banner as `Outage marker: absent` — true for the
 * first two, false (and the opposite of the truth) for the third. These
 * tests exist to pin that each of the five statuses below is produced by
 * the input that should produce it, and ONLY that input.
 *
 * Follows this directory's established tmp-dir convention
 * (`reindex-state.test.ts`): a `tmpDirs` array drained by `afterEach` via
 * `rmSync`, each test's own tmp dir built on `makeFixtureTempDir`. No
 * mocking of the filesystem — every assertion below is a real read against
 * a real file (or a real directory standing in a file's place for the
 * `unreadable` axis — never `chmodSync`, which is a no-op against
 * `readFileSync`'s EACCES check when the runner is root, true of both this
 * container and CI; see `state-read.test.ts`'s own top comment for the
 * same note).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { OUTAGE_MARKER_TTL_DAYS, assessInstrumentationHealth, readOutageMarker } from './probe.js'
import type { RetrievalLogOutageMarker } from './schema.js'
import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

// ── Helpers ──────────────────────────────────────────────────────────────

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
  const d = makeFixtureTempDir('probe-test')
  tmpDirs.push(d)
  return d
}

function markerPath(): string {
  return join(tmpDir(), 'retrieval-log.outage.json')
}

const NOW = new Date('2026-05-02T12:00:00.000Z')

function makeMarker(overrides: Partial<RetrievalLogOutageMarker> = {}): RetrievalLogOutageMarker {
  return {
    ts: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h ago — live
    reason: 'binding_unavailable',
    error: 'native binding for better-sqlite3 not found',
    hint: 'run ./scripts/repair-host-native-deps.sh',
    ...overrides,
  }
}

// ── readOutageMarker — the five-way classification ─────────────────────

describe('readOutageMarker', () => {
  it('(a) absent: no marker file -> status absent', () => {
    const path = markerPath()
    expect(readOutageMarker(path, NOW)).toEqual({ status: 'absent' })
  })

  it('(b) present: a live, structurally valid marker -> status present, marker carried', () => {
    const path = markerPath()
    const marker = makeMarker()
    writeFileSync(path, JSON.stringify(marker))
    expect(readOutageMarker(path, NOW)).toEqual({ status: 'present', marker })
  })

  it('(c) expired: older than the TTL -> status expired, marker STILL carried', () => {
    const path = markerPath()
    const marker = makeMarker({
      ts: new Date(
        NOW.getTime() - (OUTAGE_MARKER_TTL_DAYS + 1) * 24 * 60 * 60 * 1000
      ).toISOString(),
    })
    writeFileSync(path, JSON.stringify(marker))
    const result = readOutageMarker(path, NOW)
    expect(result.status).toBe('expired')
    // A caller doing its own logging/auditing may still want to know what
    // the expired marker said — see readOutageMarker's own doc comment.
    expect(result.status === 'expired' && result.marker).toEqual(marker)
  })

  it('boundary: exactly OUTAGE_MARKER_TTL_DAYS old is still present, not expired', () => {
    const path = markerPath()
    const marker = makeMarker({
      ts: new Date(NOW.getTime() - OUTAGE_MARKER_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    })
    writeFileSync(path, JSON.stringify(marker))
    expect(readOutageMarker(path, NOW)).toEqual({ status: 'present', marker })
  })

  it('(d) malformed JSON: unparseable bytes -> status malformed, non-empty detail', () => {
    const path = markerPath()
    writeFileSync(path, '{ this is not valid JSON ')
    const result = readOutageMarker(path, NOW)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail.length > 0).toBe(true)
  })

  it('(e) present, parses, but missing a required field -> status malformed', () => {
    const path = markerPath()
    // Valid JSON, valid object, but no `hint` — distinct from (d): this
    // bytes-level parse succeeds; only the field-shape check rejects it.
    writeFileSync(
      path,
      JSON.stringify({
        ts: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        reason: 'binding_unavailable',
        error: 'native binding not found',
        // hint omitted
      })
    )
    const result = readOutageMarker(path, NOW)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail.length > 0).toBe(true)
  })

  it('present but ts does not parse as a date -> status malformed (not silently absent)', () => {
    const path = markerPath()
    writeFileSync(
      path,
      JSON.stringify({
        ts: 'not-a-date',
        reason: 'binding_unavailable',
        error: 'x',
        hint: 'y',
      })
    )
    const result = readOutageMarker(path, NOW)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('not-a-date')
  })

  it('(f) unreadable: a directory stands where the marker file is expected -> status unreadable, detail carries the errno', () => {
    // Per this file's top comment: chmodSync is a no-op against
    // readFileSync's EACCES check when the runner is root (true of both
    // this container and CI) — a directory-in-place-of-file is the
    // portable way to force an EISDIR at any uid, confirmed empirically
    // for the shared reader this delegates to (state-read.test.ts).
    const path = markerPath()
    mkdirSync(path, { recursive: true })
    const result = readOutageMarker(path, NOW)
    expect(result.status).toBe('unreadable')
    expect(result.status === 'unreadable' && result.detail).toContain('EISDIR')
  })

  it('(g) known-negative control: the SAME path reads absent, then malformed, in one execution', () => {
    // Without this, every malformed/unreadable assertion above it could
    // pass against a reader that returns an error for literally
    // everything (CLAUDE.md's measure-don't-reason rule; matches
    // state-read.test.ts's own "ok control" convention) — this asserts
    // BOTH directions against the identical path in one test body.
    const path = markerPath()
    expect(readOutageMarker(path, NOW)).toEqual({ status: 'absent' })
    writeFileSync(path, '{ not valid json at all')
    const result = readOutageMarker(path, NOW)
    expect(result.status).toBe('malformed')
  })
})

// ── assessInstrumentationHealth — outageMarkerRead wiring ───────────────

describe('assessInstrumentationHealth — outageMarkerRead propagation', () => {
  async function probeWithMarkerDir(
    markerDir: string,
    overrides: Partial<Parameters<typeof assessInstrumentationHealth>[0]> = {}
  ) {
    return assessInstrumentationHealth({
      outageMarkerPath: join(markerDir, 'retrieval-log.outage.json'),
      dbPath: join(markerDir, 'does-not-exist.db'),
      now: NOW,
      staleHours: 24,
      jsonlSessionCount24h: 0,
      ...overrides,
    })
  }

  it('absent marker: outageMarkerRead.status is absent, outageMarker stays null, reason healthy', async () => {
    const dir = tmpDir()
    const result = await probeWithMarkerDir(dir)
    expect(result.outageMarkerRead).toEqual({ status: 'absent' })
    expect(result.outageMarker).toBeNull()
    expect(result.reason).toBe('healthy')
  })

  it('present marker: outageMarkerRead.status is present AND outageMarker carries the same marker', async () => {
    const dir = tmpDir()
    const marker = makeMarker()
    writeFileSync(join(dir, 'retrieval-log.outage.json'), JSON.stringify(marker))
    const result = await probeWithMarkerDir(dir)
    expect(result.outageMarkerRead).toEqual({ status: 'present', marker })
    expect(result.outageMarker).toEqual(marker)
    expect(result.reason).toBe('outage_marker_present')
    expect(result.stale).toBe(true)
  })

  it('malformed marker: outageMarkerRead.status is malformed, but outageMarker is STILL null (kept exactly as before) and reason stays healthy', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'retrieval-log.outage.json'), '{ not valid json ')
    const result = await probeWithMarkerDir(dir)
    expect(result.outageMarkerRead.status).toBe('malformed')
    // The defect this whole module exists to fix: outageMarker alone could
    // never distinguish this from absent. It still can't — that's by
    // design (see ProbeResult's own doc comment) — but outageMarkerRead can.
    expect(result.outageMarker).toBeNull()
    expect(result.reason).toBe('healthy')
  })

  it('unreadable marker: outageMarkerRead.status is unreadable with an EISDIR detail', async () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'retrieval-log.outage.json'), { recursive: true })
    const result = await probeWithMarkerDir(dir)
    expect(result.outageMarkerRead.status).toBe('unreadable')
    expect(
      result.outageMarkerRead.status === 'unreadable' && result.outageMarkerRead.detail
    ).toContain('EISDIR')
    expect(result.outageMarker).toBeNull()
  })

  it('expired marker: outageMarkerRead.status is expired (NOT absent, NOT malformed) while reason still falls through to healthy', async () => {
    const dir = tmpDir()
    const marker = makeMarker({
      ts: new Date(
        NOW.getTime() - (OUTAGE_MARKER_TTL_DAYS + 1) * 24 * 60 * 60 * 1000
      ).toISOString(),
    })
    writeFileSync(join(dir, 'retrieval-log.outage.json'), JSON.stringify(marker))
    const result = await probeWithMarkerDir(dir)
    expect(result.outageMarkerRead).toEqual({ status: 'expired', marker })
    expect(result.outageMarker).toBeNull()
    expect(result.reason).toBe('healthy')
  })

  it('probe_disabled short-circuit: outageMarkerRead is hardcoded absent without touching the filesystem', async () => {
    const dir = tmpDir()
    // A present, perfectly valid marker on disk — if the disabled branch
    // read it, outageMarkerRead would be `present`. It must not: that
    // branch is a zero-I/O short-circuit by contract.
    writeFileSync(join(dir, 'retrieval-log.outage.json'), JSON.stringify(makeMarker()))
    const saved = process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE
    try {
      process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE = '1'
      const result = await probeWithMarkerDir(dir)
      expect(result.reason).toBe('probe_disabled')
      expect(result.outageMarkerRead).toEqual({ status: 'absent' })
    } finally {
      if (saved !== undefined) process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE = saved
      else delete process.env.SKILLSMITH_RETRIEVAL_PROBE_DISABLE
    }
  })
})
