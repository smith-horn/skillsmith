/**
 * SMI-6995 — unit tests for the shared three-way state-file read.
 *
 * No mocking of the filesystem — every test writes to a unique per-test tmp
 * path via `makeFixtureTempDir`, matching every other test in this
 * directory (`reindex-state.test.ts`, `ruflo-bridge-state.test.ts`). The
 * `unreadable` axis uses a directory standing where a file is expected
 * (`readFileSync` throws `EISDIR` at any uid — measured, SMI-6995 plan M4),
 * never `chmodSync`, which does not make `readFileSync` throw when the
 * runner is root (M3/M7/M8/M9 — true of both this container and CI).
 *
 * Every axis asserts BOTH `status`/`kind` and `detail` (or `entry`), plus a
 * known-negative `ok` control per describe block — without it, every
 * malformed/unreadable/missing assertion above it could pass against a
 * reader that returned an error for literally everything (SMI-6995 plan
 * § Verification, assertion 4; CLAUDE.md's measure-don't-reason rule).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

import {
  quarantineCorruptState,
  readEntryForUpdate,
  readEntryResult,
  readRawState,
  readStateFailSoft,
} from './state-read.js'

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
  const d = makeFixtureTempDir('state-read-test')
  tmpDirs.push(d)
  return d
}

/** A fresh path, inside a fresh tmp dir, that does not exist yet. */
function statePath(): string {
  return join(tmpDir(), 'test.state')
}

interface TestEntry {
  foo: string
}

/** Checks every field a real consumer would read — a `typeof` spot-check is exactly the gap SMI-6995's plan (finding 1) warns against. */
function validateTestEntry(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object') return 'entry is not an object'
  const c = candidate as Record<string, unknown>
  if (typeof c.foo !== 'string') return 'entry.foo is not a string'
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── readRawState ─────────────────────────────────────────────────────────

describe('readRawState', () => {
  it('classifies a missing file as missing, with a stable detail', () => {
    const path = statePath()
    expect(readRawState<Record<string, unknown>>(path)).toEqual({
      ok: false,
      kind: 'missing',
      detail: 'state file does not exist',
    })
  })

  it('classifies a directory standing where the file is expected as unreadable, detail carrying EISDIR', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('unreadable')
    expect(!result.ok && result.detail).toContain('EISDIR')
  })

  it('classifies truncated JSON as malformed, detail naming the parse failure', () => {
    const path = statePath()
    writeFileSync(path, '{"a": {"b": "c')
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('malformed')
    expect(!result.ok && result.detail).toContain('does not parse')
  })

  it('classifies a JSON array as malformed, detail naming the not-an-object condition', () => {
    const path = statePath()
    writeFileSync(path, '[]\n')
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('malformed')
    expect(!result.ok && result.detail).toBe('state file is not a JSON object')
  })

  it('classifies a JSON scalar (string or number) as malformed', () => {
    const path = statePath()
    writeFileSync(path, '"hello"\n')
    expect(readRawState<Record<string, unknown>>(path).ok).toBe(false)

    writeFileSync(path, '42\n')
    expect(readRawState<Record<string, unknown>>(path).ok).toBe(false)
  })

  it('classifies a bare JSON null as malformed (falsy, not a usable object)', () => {
    const path = statePath()
    writeFileSync(path, 'null\n')
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('malformed')
  })

  it('ok control: a valid JSON object reads back exactly — proving the assertions above are not vacuous', () => {
    const path = statePath()
    const state = { 'key-a': { foo: 'bar' } }
    writeFileSync(path, `${JSON.stringify(state)}\n`)
    expect(readRawState<Record<string, unknown>>(path)).toEqual({ ok: true, state })
  })
})

// ── readEntryResult (consumer API) ──────────────────────────────────────

describe('readEntryResult', () => {
  it('returns missing when the file does not exist', () => {
    const path = statePath()
    expect(readEntryResult<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      status: 'missing',
    })
  })

  it('returns missing when the file is valid but the key is absent', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'other-key': { foo: 'bar' } })}\n`)
    expect(readEntryResult<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      status: 'missing',
    })
  })

  it('returns malformed, with the file-level detail, when the whole file does not parse', () => {
    const path = statePath()
    writeFileSync(path, '{"key-a": {"foo": "b')
    const result = readEntryResult<TestEntry>('key-a', path, validateTestEntry)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain('does not parse')
  })

  it('returns malformed, with the file-level detail, when the whole file is a JSON array', () => {
    const path = statePath()
    writeFileSync(path, '[]\n')
    const result = readEntryResult<TestEntry>('key-a', path, validateTestEntry)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toBe('state file is not a JSON object')
  })

  it('returns unreadable, detail carrying EISDIR, when a directory stands where the file is expected', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    const result = readEntryResult<TestEntry>('key-a', path, validateTestEntry)
    expect(result.status).toBe('unreadable')
    expect(result.status === 'unreadable' && result.detail).toContain('EISDIR')
  })

  it('returns malformed, detail from validate verbatim, for a present entry that fails validation', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 42 } })}\n`)
    expect(readEntryResult<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      status: 'malformed',
      detail: 'entry.foo is not a string',
    })
  })

  it('ok control: returns the entry for a present, valid key — proving the above are not vacuous', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    expect(readEntryResult<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      status: 'ok',
      entry: { foo: 'bar' },
    })
  })
})

// ── readStateFailSoft (producer API) ────────────────────────────────────

describe('readStateFailSoft', () => {
  it('returns {} for a missing file', () => {
    expect(readStateFailSoft<Record<string, unknown>>(statePath())).toEqual({})
  })

  it('returns {} for a malformed file — never throws, never reports an error', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    expect(readStateFailSoft<Record<string, unknown>>(path)).toEqual({})
  })

  it('returns {} for an unreadable file (directory in its place)', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    expect(readStateFailSoft<Record<string, unknown>>(path)).toEqual({})
  })

  it('ok control: returns the real parsed state for a valid file', () => {
    const path = statePath()
    const state = { 'key-a': { foo: 'bar' } }
    writeFileSync(path, `${JSON.stringify(state)}\n`)
    expect(readStateFailSoft<Record<string, unknown>>(path)).toEqual(state)
  })
})

// ── readEntryForUpdate (producer API) ───────────────────────────────────

describe('readEntryForUpdate', () => {
  it('missing file: entry null, priorWasCorrupt false — nothing was ever there to lose', () => {
    expect(readEntryForUpdate<TestEntry>('key-a', statePath(), validateTestEntry)).toEqual({
      entry: null,
      priorWasCorrupt: false,
    })
  })

  it('malformed file: entry null, priorWasCorrupt true — every key in the file is at risk', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    expect(readEntryForUpdate<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      entry: null,
      priorWasCorrupt: true,
    })
  })

  it('unreadable file: entry null, priorWasCorrupt true', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    expect(readEntryForUpdate<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      entry: null,
      priorWasCorrupt: true,
    })
  })

  it('valid file, key absent: entry null, priorWasCorrupt false — the file is fine, this key just never existed', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'other-key': { foo: 'bar' } })}\n`)
    expect(readEntryForUpdate<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      entry: null,
      priorWasCorrupt: false,
    })
  })

  it('valid file, key present but fails validation: entry null, priorWasCorrupt true — this key own history is lost', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 42 } })}\n`)
    expect(readEntryForUpdate<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      entry: null,
      priorWasCorrupt: true,
    })
  })

  it('ok control: valid file, key present and valid — entry returned, priorWasCorrupt false', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    expect(readEntryForUpdate<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      entry: { foo: 'bar' },
      priorWasCorrupt: false,
    })
  })
})

// ── quarantineCorruptState ──────────────────────────────────────────────

describe('quarantineCorruptState', () => {
  it('renames the file to <path>.corrupt-<ISO> and returns the new path, preserving the content', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    const dest = quarantineCorruptState(path)
    expect(dest).toMatch(
      new RegExp(
        `^${escapeRegExp(path)}\\.corrupt-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`
      )
    )
    expect(existsSync(path)).toBe(false)
    expect(dest !== null && readFileSync(dest, 'utf8')).toBe('not json{{{')
  })

  it('returns null, without throwing, when there is nothing to quarantine (missing path)', () => {
    const path = statePath()
    let result: string | null | undefined
    expect(() => {
      result = quarantineCorruptState(path)
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('never throws even when the rename itself fails for an existing-looking path (ENAMETOOLONG) — the recovery path this runs on must not itself crash', () => {
    // Measured (not inferred, per CLAUDE.md's measure-don't-reason rule):
    // renameSync on a path exceeding PATH_MAX throws ENAMETOOLONG
    // synchronously, independent of uid — confirmed live in this container
    // before writing this test. That is a DIFFERENT failure than the
    // missing-path case above (there, the source never existed; here, the
    // rename call itself fails), and quarantineCorruptState's own contract
    // is that BOTH collapse to a swallowed `null`, never a throw.
    const longPath = `${statePath()}-${'a'.repeat(5000)}`
    let result: string | null | undefined
    expect(() => {
      result = quarantineCorruptState(longPath)
    }).not.toThrow()
    expect(result).toBeNull()
  })
})
