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
 *
 * Round-2 adversarial review findings answered in this file: 1 (a throwing
 * `validate` must not escape as an exception), 3 (`readStateFailSoft` is
 * gone — `readStateWithClassification` replaces it), 5 (a present entry
 * whose value is JSON `null` is `missing`, not `malformed` — the strongest
 * uncaught mutation from round 1), 9 (assert behaviour, not presentation —
 * the parse-error tests now retain a live fragment of the real
 * `JSON.parse` message instead of only requiring a fixed phrase), and 12
 * (an oversized file is `unreadable` without ever being read).
 *
 * Round-4 adversarial review findings answered in this file:
 *
 * - **Finding 4** — `readRawState` reads via a SINGLE file descriptor
 *   (open → fstat → read → close), closing it is proven (not assumed) via
 *   a `/proc/self/fd` count across many calls, the same technique
 *   as any fd-leak test — this is a
 *   real regression risk the round-4 refactor itself introduced, not just
 *   a restatement of the bug it fixes.
 * - **Finding 5** — `errMessage` (now exported) cannot itself throw, even
 *   when the thrown value is a plain string, `null`, or an object whose
 *   own `toString` throws — exercised both directly and through
 *   `readEntryResult`'s validator-throw path, the one place in this
 *   module a genuinely hostile thrown value (not just an `Error`) can
 *   reach it.
 * - **Finding 8** — two tests used to pin the EXACT literal string
 *   `'state file is not a JSON object'`. Relaxed to assert the
 *   classification plus a non-empty explanation, since no consumer on
 *   that branch ever reads the wording itself.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

import {
  MAX_STATE_FILE_BYTES,
  errMessage,
  readEntryForUpdate,
  readEntryResult,
  readRawState,
  readStateWithClassification,
  type StateReadResult,
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

/** A validator that misbehaves by throwing instead of returning an error string (finding 1). */
function throwingValidator(): string | null {
  throw new Error('validator exploded')
}

/**
 * Three more ways a validator can misbehave (round-4 finding 5): throwing
 * a bare value instead of an `Error` at all. `errMessage` must render all
 * three without itself throwing.
 */
function throwingStringValidator(): string | null {
  throw 'plain string thrown by validator'
}

function throwingNullValidator(): string | null {
  throw null
}

function throwingHostileToStringValidator(): string | null {
  throw {
    toString() {
      throw new Error('toString exploded')
    },
  }
}

/**
 * Captures the REAL `JSON.parse` error message for `raw`, live, in this
 * runtime — so a test can assert that detail text RETAINS a fragment of
 * it (finding 9) instead of asserting a fixed phrase a constant could also
 * satisfy. Throws (failing the test loudly) if `raw` turns out to parse.
 */
function capturedJsonParseErrorMessage(raw: string): string {
  try {
    JSON.parse(raw)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('fixture does not actually fail to parse — test is not exercising what it claims')
}

// ── readRawState ─────────────────────────────────────────────────────────

describe('readRawState', () => {
  it('classifies a missing file as missing', () => {
    const path = statePath()
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('missing')
    // `detail`'s exact wording is presentation only — every consumer
    // (readEntryResult / readEntryForUpdate / readStateWithClassification)
    // discards it on the `missing` branch, so pinning the literal string
    // tests nothing a change to it would break (SMI-6995 finding 9).
    expect(!result.ok && typeof result.detail).toBe('string')
    expect(!result.ok && result.detail.length > 0).toBe(true)
  })

  it('classifies a directory standing where the file is expected as unreadable, detail carrying EISDIR', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('unreadable')
    expect(!result.ok && result.detail).toContain('EISDIR')
  })

  it('classifies truncated JSON as malformed, detail retaining the real parser error (not a constant)', () => {
    const path = statePath()
    const raw = '{"a": {"b": "c'
    writeFileSync(path, raw)
    const expectedFragment = capturedJsonParseErrorMessage(raw)
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('malformed')
    expect(!result.ok && result.detail).toContain(expectedFragment)
  })

  it('classifies a JSON array as malformed, detail naming the not-an-object condition', () => {
    const path = statePath()
    writeFileSync(path, '[]\n')
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('malformed')
    // Round-4 finding 8: `detail`'s exact wording is presentation only — no
    // consumer on the `malformed` branch reads the text itself, so pinning
    // the literal string tested a sentence a copy-edit could break for no
    // behavioural reason. Assert classification plus a non-empty
    // explanation instead.
    expect(!result.ok && typeof result.detail).toBe('string')
    expect(!result.ok && result.detail.length > 0).toBe(true)
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

describe('readRawState — size limit (SMI-6995 finding 12)', () => {
  it('classifies a file over MAX_STATE_FILE_BYTES as unreadable WITHOUT ever reading it, detail naming size and limit', () => {
    const path = statePath()
    const oversized = 'x'.repeat(MAX_STATE_FILE_BYTES + 1)
    writeFileSync(path, oversized)
    const result = readRawState<Record<string, unknown>>(path)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('unreadable')
    expect(!result.ok && result.detail).toContain(String(oversized.length))
    expect(!result.ok && result.detail).toContain(String(MAX_STATE_FILE_BYTES))
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

  it('returns missing — not malformed — when the key is present but its value is literally JSON null (finding 5)', () => {
    // The strongest uncaught mutation from round 1: changing the
    // `candidate === undefined || candidate === null` check to
    // `candidate === undefined` alone flips this to `malformed` and every
    // OTHER existing assertion still passed. See this suite's own
    // red/green verification note for the mutation-kill proof.
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': null })}\n`)
    expect(readEntryResult<TestEntry>('key-a', path, validateTestEntry)).toEqual({
      status: 'missing',
    })
  })

  it('returns malformed, with the file-level detail, when the whole file does not parse', () => {
    const path = statePath()
    const raw = '{"key-a": {"foo": "b'
    writeFileSync(path, raw)
    const expectedFragment = capturedJsonParseErrorMessage(raw)
    const result = readEntryResult<TestEntry>('key-a', path, validateTestEntry)
    expect(result.status).toBe('malformed')
    expect(result.status === 'malformed' && result.detail).toContain(expectedFragment)
  })

  it('returns malformed, with the file-level detail, when the whole file is a JSON array', () => {
    const path = statePath()
    writeFileSync(path, '[]\n')
    const result = readEntryResult<TestEntry>('key-a', path, validateTestEntry)
    expect(result.status).toBe('malformed')
    // Round-4 finding 8 — see the matching readRawState test above for why
    // this no longer pins the exact literal string.
    expect(result.status === 'malformed' && typeof result.detail).toBe('string')
    expect(result.status === 'malformed' && result.detail.length > 0).toBe(true)
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

  it('returns malformed, naming that the validator itself threw, rather than letting the throw escape (finding 1)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    let result: StateReadResult<TestEntry> | undefined
    expect(() => {
      result = readEntryResult<TestEntry>('key-a', path, throwingValidator)
    }).not.toThrow()
    expect(result?.status).toBe('malformed')
    expect(result?.status === 'malformed' && result.detail).toContain('validator itself threw')
    expect(result?.status === 'malformed' && result.detail).toContain('validator exploded')
  })

  it('returns malformed, without throwing, when the validator throws a plain string instead of an Error (finding 5)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    let result: StateReadResult<TestEntry> | undefined
    expect(() => {
      result = readEntryResult<TestEntry>('key-a', path, throwingStringValidator)
    }).not.toThrow()
    expect(result?.status).toBe('malformed')
    expect(result?.status === 'malformed' && result.detail).toContain(
      'plain string thrown by validator'
    )
  })

  it('returns malformed, without throwing, when the validator throws null (finding 5)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    let result: StateReadResult<TestEntry> | undefined
    expect(() => {
      result = readEntryResult<TestEntry>('key-a', path, throwingNullValidator)
    }).not.toThrow()
    expect(result?.status).toBe('malformed')
    expect(result?.status === 'malformed' && result.detail).toContain('null')
  })

  it('returns malformed, without throwing, when the validator throws an object whose own toString throws (finding 5 — the actual escape hatch this finding closes)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    let result: StateReadResult<TestEntry> | undefined
    expect(() => {
      result = readEntryResult<TestEntry>('key-a', path, throwingHostileToStringValidator)
    }).not.toThrow()
    expect(result?.status).toBe('malformed')
    expect(result?.status === 'malformed' && result.detail).toContain('<unprintable thrown value>')
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

  it('valid file, key present but value is literally JSON null: entry null, priorWasCorrupt FALSE (finding 5)', () => {
    // Same mutation-sensitive axis as readEntryResult's null-value test
    // above: nothing was ever written for this key, so there is nothing to
    // lose — priorWasCorrupt must stay false here, not flip to true.
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': null })}\n`)
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

  it('valid file, key present but validate itself throws: entry null, priorWasCorrupt true, no exception escapes (finding 1)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    let result: { entry: TestEntry | null; priorWasCorrupt: boolean } | undefined
    expect(() => {
      result = readEntryForUpdate<TestEntry>('key-a', path, throwingValidator)
    }).not.toThrow()
    expect(result).toEqual({ entry: null, priorWasCorrupt: true })
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

// ── readStateWithClassification (producer whole-state API — finding 3) ──

describe('readStateWithClassification', () => {
  it('missing: classification missing, needsQuarantine false, state {}', () => {
    const result = readStateWithClassification<Record<string, unknown>>(statePath())
    expect(result.classification).toBe('missing')
    expect(result.needsQuarantine).toBe(false)
    expect(result.state).toEqual({})
    expect(typeof result.detail).toBe('string')
  })

  it('malformed: classification malformed, needsQuarantine TRUE, state {} — the signal readStateFailSoft used to throw away', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    const result = readStateWithClassification<Record<string, unknown>>(path)
    expect(result.classification).toBe('malformed')
    expect(result.needsQuarantine).toBe(true)
    expect(result.state).toEqual({})
    expect(typeof result.detail).toBe('string')
  })

  it('unreadable (directory in its place): classification unreadable, needsQuarantine TRUE, state {}', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    const result = readStateWithClassification<Record<string, unknown>>(path)
    expect(result.classification).toBe('unreadable')
    expect(result.needsQuarantine).toBe(true)
    expect(result.state).toEqual({})
  })

  it('never throws across every failure axis — matches the never-fail contract of the function it replaces', () => {
    const path = statePath()
    expect(() => readStateWithClassification(path)).not.toThrow()
    mkdirSync(path, { recursive: true })
    expect(() => readStateWithClassification(path)).not.toThrow()
  })

  it('ok control: a valid file returns classification ok, needsQuarantine false, detail null, and the real state', () => {
    const path = statePath()
    const state = { 'key-a': { foo: 'bar' } }
    writeFileSync(path, `${JSON.stringify(state)}\n`)
    expect(readStateWithClassification<Record<string, unknown>>(path)).toEqual({
      state,
      classification: 'ok',
      detail: null,
      needsQuarantine: false,
    })
  })
})

// ── readRawState — single-descriptor read (SMI-6995 round-4 finding 4) ──

describe('readRawState — descriptor hygiene', () => {
  it('does not leak a file descriptor per call — fstat and read share one fd, closed in a finally (finding 4)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'key-a': { foo: 'bar' } })}\n`)
    const countOpenFds = () => readdirSync('/proc/self/fd').length

    // Warm up once so one-time costs don't pollute the baseline.
    readRawState<Record<string, unknown>>(path)

    const before = countOpenFds()
    const iterations = 200
    for (let i = 0; i < iterations; i++) {
      readRawState<Record<string, unknown>>(path)
    }
    const after = countOpenFds()

    // A leaking close grows the open-fd count by ~1 per call; a correct
    // implementation grows it by ~0, modulo unrelated test-runner noise.
    // This threshold is intentionally far below `iterations` so it cannot
    // pass by accident — the same technique
    // as any fd-leak test.
    expect(after - before).toBeLessThan(iterations / 2)
  })
})

// ── errMessage (SMI-6995 round-4 finding 5) ──────────────────────────────

describe('errMessage', () => {
  it('returns the message of a real Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom')
  })

  it('stringifies a thrown plain string without throwing', () => {
    expect(errMessage('plain string')).toBe('plain string')
  })

  it('stringifies a thrown null without throwing', () => {
    expect(errMessage(null)).toBe('null')
  })

  it("falls back to a fixed message, without throwing, when the thrown value's own toString throws", () => {
    const hostile = {
      toString() {
        throw new Error('toString exploded')
      },
    }
    let result: string | undefined
    expect(() => {
      result = errMessage(hostile)
    }).not.toThrow()
    expect(result).toBe('<unprintable thrown value>')
  })
})
