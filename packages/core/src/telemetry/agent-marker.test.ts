/**
 * SMI-5456: Tests for the agent-mediation marker channel.
 *
 * Covers the P-5 shared-state invariants for the session marker file:
 *   - `_meta` wins over the marker file (per-field precedence)
 *   - marker file alone works
 *   - neither present ⇒ fields default false / false / null
 *   - stale (past-TTL) marker is ignored
 *   - corrupt / malformed marker file is ignored, never throws
 *   - `_meta` extraction is defensive (junk types dropped)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAgentMarker,
  readSessionMarker,
  extractMarkerMeta,
  NO_AGENT_MARKER,
  AGENT_MARKER_TTL_MS,
  AGENT_MARKER_SCHEMA_VERSION,
  AGENT_MARKER_MAX_FILE_BYTES,
  type AgentMarkerFile,
} from './agent-marker.js'

let markerDir: string
const NOW = 1_720_000_000_000 // fixed clock for deterministic TTL math

function writeMarker(name: string, file: Record<string, unknown>): void {
  writeFileSync(join(markerDir, name), JSON.stringify(file), 'utf-8')
}

function freshMarker(overrides: Partial<AgentMarkerFile> = {}): Record<string, unknown> {
  return {
    schema: AGENT_MARKER_SCHEMA_VERSION,
    session_id: 'sess-1',
    started_at: NOW - 1000,
    harness: 'claude-code',
    ...overrides,
  }
}

beforeEach(() => {
  markerDir = mkdtempSync(join(tmpdir(), 'skillsmith-marker-'))
  process.env.SKILLSMITH_AGENT_MARKER_DIR = markerDir
})

afterEach(() => {
  delete process.env.SKILLSMITH_AGENT_MARKER_DIR
  rmSync(markerDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// readSessionMarker
// ---------------------------------------------------------------------------

describe('readSessionMarker', () => {
  it('returns null when the marker directory does not exist', () => {
    rmSync(markerDir, { recursive: true, force: true })
    expect(readSessionMarker({ now: NOW })).toBeNull()
  })

  it('reads a fresh marker file (presence ⇒ agent session)', () => {
    writeMarker('a.json', freshMarker())
    expect(readSessionMarker({ now: NOW })).toEqual({
      agentSession: true,
      nudgeOrigin: false,
      triggerId: null,
    })
  })

  it('surfaces explicit nudge_origin + trigger_id from the file', () => {
    writeMarker('a.json', freshMarker({ nudge_origin: true, trigger_id: 'T1' }))
    expect(readSessionMarker({ now: NOW })).toEqual({
      agentSession: true,
      nudgeOrigin: true,
      triggerId: 'T1',
    })
  })

  it('honours an explicit agent_session:false opt-out', () => {
    writeMarker('a.json', freshMarker({ agent_session: false }))
    expect(readSessionMarker({ now: NOW })?.agentSession).toBe(false)
  })

  it('ignores a marker past the TTL', () => {
    writeMarker('a.json', freshMarker({ started_at: NOW - AGENT_MARKER_TTL_MS - 1 }))
    expect(readSessionMarker({ now: NOW })).toBeNull()
  })

  it('keeps a marker exactly at the TTL boundary', () => {
    writeMarker('a.json', freshMarker({ started_at: NOW - AGENT_MARKER_TTL_MS }))
    expect(readSessionMarker({ now: NOW })?.agentSession).toBe(true)
  })

  it('selects the freshest non-expired marker among several', () => {
    writeMarker('old.json', freshMarker({ session_id: 'old', started_at: NOW - 5000 }))
    writeMarker(
      'new.json',
      freshMarker({ session_id: 'new', started_at: NOW - 100, trigger_id: 'T-NEW' })
    )
    expect(readSessionMarker({ now: NOW })?.triggerId).toBe('T-NEW')
  })

  it('ignores corrupt JSON without throwing', () => {
    writeFileSync(join(markerDir, 'bad.json'), '{ not valid json', 'utf-8')
    expect(readSessionMarker({ now: NOW })).toBeNull()
  })

  it('ignores a marker missing session_id or started_at', () => {
    writeMarker('no-session.json', { started_at: NOW - 100 })
    writeMarker('no-time.json', { session_id: 'x' })
    expect(readSessionMarker({ now: NOW })).toBeNull()
  })

  it('ignores non-.json files and falls back to a valid sibling', () => {
    writeFileSync(join(markerDir, 'note.txt'), 'ignored', 'utf-8')
    writeMarker('a.json', freshMarker({ trigger_id: 'T2' }))
    expect(readSessionMarker({ now: NOW })?.triggerId).toBe('T2')
  })

  it('ignores a marker file over AGENT_MARKER_MAX_FILE_BYTES without throwing', () => {
    // A well-formed marker is a few hundred bytes; pad `trigger_id` past the
    // cap to simulate a corrupt/hostile oversized file on the hot read path.
    const oversizedTriggerId = 'x'.repeat(AGENT_MARKER_MAX_FILE_BYTES + 1)
    writeMarker('huge.json', freshMarker({ trigger_id: oversizedTriggerId }))
    expect(readSessionMarker({ now: NOW })).toBeNull()
  })

  it('ignores a symlink instead of following it', () => {
    // Target lives OUTSIDE markerDir and is otherwise perfectly valid — if the
    // reader followed the symlink it would resolve `trigger_id: 'OUTSIDE'`.
    // `lstat` must reject the symlink entry before `readFileSync` ever runs.
    const outsideDir = mkdtempSync(join(tmpdir(), 'skillsmith-marker-outside-'))
    const outsidePath = join(outsideDir, 'target.json')
    writeFileSync(outsidePath, JSON.stringify(freshMarker({ trigger_id: 'OUTSIDE' })), 'utf-8')
    symlinkSync(outsidePath, join(markerDir, 'link.json'))

    expect(readSessionMarker({ now: NOW })).toBeNull()

    rmSync(outsideDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// extractMarkerMeta (defensive _meta validation)
// ---------------------------------------------------------------------------

describe('extractMarkerMeta', () => {
  it('returns empty for non-object input', () => {
    expect(extractMarkerMeta(undefined)).toEqual({})
    expect(extractMarkerMeta(null)).toEqual({})
    expect(extractMarkerMeta('nope')).toEqual({})
    expect(extractMarkerMeta(42)).toEqual({})
  })

  it('extracts well-typed fields', () => {
    expect(
      extractMarkerMeta({ agent_session: true, nudge_origin: false, trigger_id: 'T9' })
    ).toEqual({ agentSession: true, nudgeOrigin: false, triggerId: 'T9' })
  })

  it('accepts an explicit null trigger_id', () => {
    expect(extractMarkerMeta({ trigger_id: null })).toEqual({ triggerId: null })
  })

  it('drops junk / wrongly-typed values', () => {
    expect(
      extractMarkerMeta({
        agent_session: 'true', // string, not boolean
        nudge_origin: 1, // number, not boolean
        trigger_id: 123, // number, not string
        unrelated: 'ignored',
      })
    ).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// resolveAgentMarker (precedence)
// ---------------------------------------------------------------------------

describe('resolveAgentMarker', () => {
  it('returns the neutral default when neither _meta nor file is present', () => {
    expect(resolveAgentMarker(undefined, { now: NOW })).toEqual(NO_AGENT_MARKER)
  })

  it('uses the marker file when _meta is absent', () => {
    writeMarker('a.json', freshMarker({ nudge_origin: true, trigger_id: 'FILE' }))
    expect(resolveAgentMarker(undefined, { now: NOW })).toEqual({
      agentSession: true,
      nudgeOrigin: true,
      triggerId: 'FILE',
    })
  })

  it('lets _meta win over the marker file per field', () => {
    writeMarker(
      'a.json',
      freshMarker({ agent_session: true, nudge_origin: true, trigger_id: 'FILE' })
    )
    const resolved = resolveAgentMarker({ agent_session: false, trigger_id: 'META' }, { now: NOW })
    // agent_session + trigger_id come from _meta; nudge_origin falls back to file.
    expect(resolved).toEqual({ agentSession: false, nudgeOrigin: true, triggerId: 'META' })
  })

  it('lets _meta provide fields with no marker file at all', () => {
    expect(resolveAgentMarker({ agent_session: true }, { now: NOW })).toEqual({
      agentSession: true,
      nudgeOrigin: false,
      triggerId: null,
    })
  })

  it('an expired file behaves as no file (falls through to _meta / default)', () => {
    writeMarker(
      'a.json',
      freshMarker({ started_at: NOW - AGENT_MARKER_TTL_MS - 1, trigger_id: 'STALE' })
    )
    expect(resolveAgentMarker(undefined, { now: NOW })).toEqual(NO_AGENT_MARKER)
  })
})
