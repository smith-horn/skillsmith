/**
 * SMI-6995 — unit tests for corrupt-state quarantine and the coordinated
 * recovery writer (`quarantineCorruptState`, `writeEntryWithRecovery`).
 * Split out of `state-read.test.ts`, matching the production split in
 * `state-read.quarantine.ts` (see that module's top doc comment for why).
 *
 * Same no-mocking, unique-tmp-path-per-test convention as the sibling file.
 * The `unreadable`/directory axis uses a real directory, never `chmodSync`
 * (a no-op under root — true of both this container and CI).
 *
 * Round-2 adversarial review findings answered in this file:
 *
 * - **Finding 2** — exclusive destination allocation is PROVEN, not
 *   assumed: tests pre-occupy the derived destination name (and, for the
 *   exhaustion test, every bounded fallback slot) and assert the EARLIER
 *   content survives untouched — a bare `existsSync`-then-`renameSync`
 *   implementation would fail these by silently overwriting what was
 *   already there.
 * - **Finding 6** — the old "rename itself fails" test built an overlong
 *   path and never created a real source file at it, so it only proved
 *   pathname-resolution failure, not a destination-side failure, and would
 *   have passed against a stub that always returns null. The replacement
 *   below creates a REAL source file and forces a destination-side
 *   failure deterministically (every bounded destination slot pre-taken)
 *   — no chmod, no symlink tricks, no reliance on OS-specific path limits.
 * - **Finding 7** — a directory refuses quarantine; left intact.
 * - **Finding 8** — a symlink refuses quarantine; link AND target left
 *   intact.
 * - **Finding 9** — the base "quarantine preserves content" test no
 *   longer pins the destination filename's timestamp format (that's
 *   presentation); it asserts the preservation behaviour that actually
 *   matters — bytes identical at whatever path was returned.
 * - **Finding 4** — `writeEntryWithRecovery` is tested across all four
 *   `readRawState` outcomes it must route correctly (missing / ok /
 *   malformed / the directory case that makes the final write itself
 *   throw), proving read+quarantine+merge+write really happened as one
 *   coordinated operation rather than three separable steps.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

import {
  QUARANTINE_DEST_MAX_ATTEMPTS,
  quarantineCorruptState,
  writeEntryWithRecovery,
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
  const d = makeFixtureTempDir('state-read-quarantine-test')
  tmpDirs.push(d)
  return d
}

/** A fresh path, inside a fresh tmp dir, that does not exist yet. */
function statePath(): string {
  return join(tmpDir(), 'test.state')
}

function derivedQuarantineBase(path: string, now: Date): string {
  return `${path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
}

// ── quarantineCorruptState ──────────────────────────────────────────────

describe('quarantineCorruptState', () => {
  it('quarantines corrupt bytes to a sibling path and returns it, preserving the content exactly (behaviour, not filename format — finding 9)', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    const dest = quarantineCorruptState(path)
    expect(dest).not.toBeNull()
    expect(dest).not.toBe(path)
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

  it('never throws when lstat on the source path itself fails for a reason other than ENOENT (ENAMETOOLONG)', () => {
    // Measured (not inferred, per CLAUDE.md's measure-don't-reason rule):
    // lstatSync on a path exceeding PATH_MAX throws ENAMETOOLONG
    // synchronously, independent of uid — confirmed live in this container
    // before writing this test. quarantineCorruptState's lstat happens
    // FIRST, before any destination logic, so this is a DIFFERENT failure
    // than the missing-path case above (lstat throws ENOENT there; a
    // different errno here) — both must collapse to the same swallowed
    // `null`, never a throw.
    const longPath = `${statePath()}-${'a'.repeat(5000)}`
    let result: string | null | undefined
    expect(() => {
      result = quarantineCorruptState(longPath)
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('allocates a different destination when the derived one already exists, preserving what was already there (finding 2)', () => {
    const path = statePath()
    writeFileSync(path, 'corrupt payload')
    const now = new Date('2026-02-02T02:02:02.000Z')
    const expectedBase = derivedQuarantineBase(path, now)
    writeFileSync(expectedBase, 'EARLIER QUARANTINE — MUST SURVIVE')

    const dest = quarantineCorruptState(path, now)

    expect(dest).not.toBeNull()
    expect(dest).not.toBe(expectedBase)
    // Proof of exclusivity, not an assumption: a bare existsSync-then-
    // renameSync implementation would have clobbered this.
    expect(readFileSync(expectedBase, 'utf8')).toBe('EARLIER QUARANTINE — MUST SURVIVE')
    expect(dest !== null && readFileSync(dest, 'utf8')).toBe('corrupt payload')
  })

  it('two quarantines at the exact same clock instant land at two different destinations, both surviving (finding 2)', () => {
    const path = statePath()
    const now = new Date('2026-03-03T03:03:03.000Z')

    writeFileSync(path, 'first corrupt payload')
    const dest1 = quarantineCorruptState(path, now)

    writeFileSync(path, 'second corrupt payload')
    const dest2 = quarantineCorruptState(path, now)

    expect(dest1).not.toBeNull()
    expect(dest2).not.toBeNull()
    expect(dest1).not.toBe(dest2)
    expect(dest1 !== null && readFileSync(dest1, 'utf8')).toBe('first corrupt payload')
    expect(dest2 !== null && readFileSync(dest2, 'utf8')).toBe('second corrupt payload')
  })

  it('refuses (null, source untouched) when every destination slot up to the bounded retry count is already taken — deterministic destination-side failure, no chmod (finding 6)', () => {
    const path = statePath()
    const originalBytes = 'the real corrupt payload — must survive'
    writeFileSync(path, originalBytes)
    const now = new Date('2026-04-04T04:04:04.000Z')
    const base = derivedQuarantineBase(path, now)
    writeFileSync(base, 'occupied')
    for (let n = 2; n <= QUARANTINE_DEST_MAX_ATTEMPTS; n++) {
      writeFileSync(`${base}-${n}`, 'occupied')
    }

    const result = quarantineCorruptState(path, now)

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(originalBytes)
  })

  it('refuses to quarantine a directory standing at the state path — returns null, directory left intact (finding 7)', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'inner.txt'), 'must not be touched')

    const result = quarantineCorruptState(path)

    expect(result).toBeNull()
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(readFileSync(join(path, 'inner.txt'), 'utf8')).toBe('must not be touched')
  })

  it('refuses to quarantine a symlink standing at the state path — returns null, link AND target left intact (finding 8)', () => {
    const dir = tmpDir()
    const target = join(dir, 'real-target.json')
    writeFileSync(target, '{"a":1}')
    const link = join(dir, 'test.state')
    symlinkSync(target, link)

    const result = quarantineCorruptState(link)

    expect(result).toBeNull()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
  })
})

// ── writeEntryWithRecovery (finding 4) ──────────────────────────────────

interface Entry {
  foo: string
}
type State = Record<string, Entry>

describe('writeEntryWithRecovery', () => {
  it('missing file: creates it with exactly the new key, quarantinedTo null, priorWasCorrupt false', () => {
    const path = statePath()
    const result = writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' })
    expect(result).toEqual({ quarantinedTo: null, priorWasCorrupt: false })
    const written = JSON.parse(readFileSync(path, 'utf8')) as State
    expect(written).toEqual({ 'key-a': { foo: 'bar' } })
  })

  it('ok file: merges the new key in, preserving every other key untouched', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ 'other-key': { foo: 'existing' } })}\n`)
    const result = writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' })
    expect(result).toEqual({ quarantinedTo: null, priorWasCorrupt: false })
    const written = JSON.parse(readFileSync(path, 'utf8')) as State
    expect(written).toEqual({
      'other-key': { foo: 'existing' },
      'key-a': { foo: 'bar' },
    })
  })

  it('malformed file: quarantines the corrupt bytes (preserved at quarantinedTo), new file starts clean with ONLY the new key, priorWasCorrupt true', () => {
    const path = statePath()
    const corruptBytes = 'not json{{{'
    writeFileSync(path, corruptBytes)
    const now = new Date('2026-05-05T05:05:05.000Z')

    const result = writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' }, { now })

    expect(result.priorWasCorrupt).toBe(true)
    expect(result.quarantinedTo).not.toBeNull()
    expect(result.quarantinedTo !== null && readFileSync(result.quarantinedTo, 'utf8')).toBe(
      corruptBytes
    )
    const written = JSON.parse(readFileSync(path, 'utf8')) as State
    expect(written).toEqual({ 'key-a': { foo: 'bar' } })
  })

  it('directory at the state path: quarantine refuses it (finding 7) and the final write throws instead of destroying the directory — matches the write-can-fail contract of the writers it replaces', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    expect(() => writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' })).toThrow()
    expect(lstatSync(path).isDirectory()).toBe(true)
  })
})
