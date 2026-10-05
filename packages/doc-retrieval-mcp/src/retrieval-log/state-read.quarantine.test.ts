/**
 * SMI-6995 — unit tests for corrupt-state preservation and the coordinated
 * recovery writer (`copyCorruptStateAside`, `writeEntryWithRecovery`,
 * `finalizeAtomicWrite`). Split out of `state-read.test.ts`, matching the
 * production split in `state-read.quarantine.ts` (see that module's top
 * doc comment for why, including the round-4 design decisions it
 * implements).
 *
 * Same no-mocking, unique-tmp-path-per-test convention as the sibling file,
 * with ONE measured exception noted at `finalizeAtomicWrite`'s own describe
 * block below — mocking `node:fs` turned out not to be available at all in
 * this project's ESM/vitest setup, so that branch is reached with a
 * completely real `ENOENT` instead. The `unreadable`/directory axis uses a
 * real directory, never `chmodSync` (a no-op under root — true of both
 * this container and CI). The fd-leak and reservation-cleanup axes use a
 * real AF_UNIX socket file as a deterministic, non-blocking, no-privilege
 * way to make `copyFileSync` fail on a real errno (`ENXIO`) — measured live
 * before writing these tests, not assumed.
 *
 * Round-4 adversarial review findings answered in this file (round-2
 * findings carried over unchanged — directory refusal, symlink refusal —
 * are labeled "round 2" below to avoid colliding with round 4's OWN
 * finding 7, a completely different issue that reuses the same number):
 *
 * - **Finding 2** — `copyCorruptStateAside` no longer removes `path`; the
 *   base "preserves content" test now asserts `path` SURVIVES every call,
 *   which it could not have under the old rename-based implementation.
 *   `writeEntryWithRecovery`'s own failure path (copy-aside fails) is now
 *   tested, and `finalizeAtomicWrite`'s failure path (copy-aside succeeds,
 *   the rename after it still fails) is tested directly.
 * - **Finding 3** — a destination reserved but never successfully filled
 *   is cleaned up: forcing a real, deterministic copy failure AFTER a real
 *   successful reservation (via the socket trick) and asserting the empty
 *   destination is gone, not left behind as a dead slot.
 * - **Finding 6** — `allocateQuarantineDest`'s own fd cannot leak: a
 *   `/proc/self/fd` count across many calls proves the close actually
 *   happens, rather than assuming it from the source.
 * - **Finding 7** — the old "real-source rename failure" test
 *   (`copyCorruptStateAside`'s destination-exhaustion test) never actually
 *   reached a rename/copy at all — every slot pre-occupied means
 *   allocation itself returns `null` first. That test is kept (it still
 *   proves the allocation bound) but retitled to say so; the
 *   reservation-succeeds-then-copy-fails case it was mistaken for is now
 *   covered by the SAME test that answers finding 3, with both of this
 *   finding's own required assertions — source preservation AND
 *   reservation cleanup.
 * - **Finding 8** (pinned-detail-text brittleness) has no equivalent
 *   assertion in THIS file to relax — see `state-read.test.ts`'s own
 *   doc comment for where it is actually answered.
 * - **Finding 9 (sound)** — the base "preserves content" test no longer
 *   pins the destination filename's timestamp format (that is
 *   presentation); it asserts the preservation behaviour that actually
 *   matters — bytes identical at whatever path was returned, AND at `path`
 *   itself, which now also still has them.
 * - **Round 2's finding 7** (directory refusal) and **finding 8** (symlink
 *   refusal) are unchanged in behaviour — reviewed sound by round 4 — and
 *   their tests are retained, labeled "round 2" to disambiguate from round
 *   4's own finding 7 above.
 * - **Finding 4 (round 2 numbering)** — `writeEntryWithRecovery` is tested
 *   across all the `readRawState` outcomes it must route correctly
 *   (missing / ok / malformed / the directory case that makes copy-aside
 *   itself refuse),
 *   proving read+copy+merge+write really happened as one coordinated
 *   operation.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'

import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

import {
  QUARANTINE_DEST_MAX_ATTEMPTS,
  RecoveryWriteError,
  copyCorruptStateAside,
  finalizeAtomicWrite,
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

/**
 * Listens a real AF_UNIX socket at `path` and resolves once it is ready.
 * `lstatSync` reports a socket as neither a directory nor a symlink (so it
 * passes `copyCorruptStateAside`'s own refusal checks), but `copyFileSync`
 * cannot `open(2)` it for reading — confirmed live: this fails with
 * `ENXIO`, immediately, never blocking — which gives these tests a
 * deterministic, real, non-mocked, no-privilege way to make the COPY step
 * specifically fail without touching the destination's reservation.
 */
function listenUnixSocket(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(path, () => resolve(srv))
  })
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => srv.close(() => resolve()))
}

// ── copyCorruptStateAside ───────────────────────────────────────────────

describe('copyCorruptStateAside', () => {
  it('copies corrupt bytes to a sibling path, preserving them at BOTH locations — path is never moved (design decision C, finding 9)', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    const dest = copyCorruptStateAside(path)
    expect(dest).not.toBeNull()
    expect(dest).not.toBe(path)
    // The defining behaviour of round-4 design decision C: `path` SURVIVES.
    // The old rename-based implementation would fail this assertion.
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('not json{{{')
    expect(dest !== null && readFileSync(dest, 'utf8')).toBe('not json{{{')
  })

  it('returns null, without throwing, when there is nothing to preserve (missing path)', () => {
    const path = statePath()
    let result: string | null | undefined
    expect(() => {
      result = copyCorruptStateAside(path)
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('never throws when lstat on the source path itself fails for a reason other than ENOENT (ENAMETOOLONG)', () => {
    // Measured (not inferred, per CLAUDE.md's measure-don't-reason rule):
    // lstatSync on a path exceeding PATH_MAX throws ENAMETOOLONG
    // synchronously, independent of uid — confirmed live in this container
    // before writing this test. copyCorruptStateAside's lstat happens
    // FIRST, before any destination logic, so this is a DIFFERENT failure
    // than the missing-path case above (lstat throws ENOENT there; a
    // different errno here) — both must collapse to the same swallowed
    // `null`, never a throw.
    const longPath = `${statePath()}-${'a'.repeat(5000)}`
    let result: string | null | undefined
    expect(() => {
      result = copyCorruptStateAside(longPath)
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('allocates a different destination when the derived one already exists, preserving what was already there AND leaving path intact (finding 2)', () => {
    const path = statePath()
    writeFileSync(path, 'corrupt payload')
    const now = new Date('2026-02-02T02:02:02.000Z')
    const expectedBase = derivedQuarantineBase(path, now)
    writeFileSync(expectedBase, 'EARLIER QUARANTINE — MUST SURVIVE')

    const dest = copyCorruptStateAside(path, now)

    expect(dest).not.toBeNull()
    expect(dest).not.toBe(expectedBase)
    // Proof of exclusivity, not an assumption: a bare existsSync-then-copy
    // implementation would have clobbered this.
    expect(readFileSync(expectedBase, 'utf8')).toBe('EARLIER QUARANTINE — MUST SURVIVE')
    expect(dest !== null && readFileSync(dest, 'utf8')).toBe('corrupt payload')
    expect(readFileSync(path, 'utf8')).toBe('corrupt payload')
  })

  it('two quarantines at the exact same clock instant land at two different destinations, both surviving, path surviving too (finding 2)', () => {
    const path = statePath()
    const now = new Date('2026-03-03T03:03:03.000Z')

    writeFileSync(path, 'first corrupt payload')
    const dest1 = copyCorruptStateAside(path, now)

    writeFileSync(path, 'second corrupt payload')
    const dest2 = copyCorruptStateAside(path, now)

    expect(dest1).not.toBeNull()
    expect(dest2).not.toBeNull()
    expect(dest1).not.toBe(dest2)
    expect(dest1 !== null && readFileSync(dest1, 'utf8')).toBe('first corrupt payload')
    expect(dest2 !== null && readFileSync(dest2, 'utf8')).toBe('second corrupt payload')
    expect(readFileSync(path, 'utf8')).toBe('second corrupt payload')
  })

  it('tests the ALLOCATION BOUND, not a rename/copy failure — exhausting every destination slot returns null before any copy is even attempted, source untouched (retained and retitled per round-4 finding 7; the reservation-succeeds-then-copy-fails case this test used to be mistaken for is covered separately below, by the "cleans up an empty reservation" test)', () => {
    const path = statePath()
    const originalBytes = 'the real corrupt payload — must survive'
    writeFileSync(path, originalBytes)
    const now = new Date('2026-04-04T04:04:04.000Z')
    const base = derivedQuarantineBase(path, now)
    writeFileSync(base, 'occupied')
    for (let n = 2; n <= QUARANTINE_DEST_MAX_ATTEMPTS; n++) {
      writeFileSync(`${base}-${n}`, 'occupied')
    }

    const result = copyCorruptStateAside(path, now)

    expect(result).toBeNull()
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(originalBytes)
  })

  it("refuses to quarantine a directory standing at the state path — returns null, directory left intact (finding 7, round 2 — distinct from round 4's own finding 7, the rename-failure test gap)", () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'inner.txt'), 'must not be touched')

    const result = copyCorruptStateAside(path)

    expect(result).toBeNull()
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(readFileSync(join(path, 'inner.txt'), 'utf8')).toBe('must not be touched')
  })

  it('refuses to quarantine a symlink standing at the state path — returns null, link AND target left intact (finding 8, round 2)', () => {
    const dir = tmpDir()
    const target = join(dir, 'real-target.json')
    writeFileSync(target, '{"a":1}')
    const link = join(dir, 'test.state')
    symlinkSync(target, link)

    const result = copyCorruptStateAside(link)

    expect(result).toBeNull()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
  })

  it('cleans up an empty reservation when the copy into it fails, instead of leaking the slot forever, source left completely untouched (finding 3; also the reservation-succeeds-then-copy-fails case round-4 finding 7 asks for, with both of ITS required assertions — source preservation AND reservation cleanup)', async () => {
    const path = statePath()
    const srv = await listenUnixSocket(path)
    try {
      const now = new Date('2026-07-07T07:07:07.000Z')
      const expectedDest = derivedQuarantineBase(path, now)

      const result = copyCorruptStateAside(path, now)

      expect(result).toBeNull()
      // The reservation at `expectedDest` genuinely succeeded (it is a
      // plain regular file with full permissions, as root) — the bug this
      // finding fixes is that a failed copy used to leave that empty
      // reservation behind forever. Asserting it is GONE is the actual
      // proof; without the finding-3 fix this would still exist (empty).
      expect(existsSync(expectedDest)).toBe(false)
      // Source preservation (finding 7's own explicit ask): the socket at
      // `path` is exactly what it was before the failed copy — still a
      // socket, never replaced or removed.
      expect(lstatSync(path).isSocket()).toBe(true)
    } finally {
      await closeServer(srv)
    }
  })

  it('does not leak a file descriptor per call — the reservation fd is closed from a finally, not a combined expression a mutation could drop silently (finding 6)', () => {
    const dir = tmpDir()
    const path = join(dir, 'test.state')
    const countOpenFds = () => readdirSync('/proc/self/fd').length

    // Warm up once so one-time costs (module init, first-call lazy work)
    // don't pollute the baseline measurement.
    writeFileSync(path, 'warm-up')
    copyCorruptStateAside(path, new Date('2026-06-06T06:06:06.000Z'))

    const before = countOpenFds()
    const iterations = 200
    for (let i = 0; i < iterations; i++) {
      // A distinct millisecond per iteration means allocateQuarantineDest
      // always succeeds on its first candidate — no collision-retry noise
      // in this measurement, and `path` is never removed by a prior
      // iteration (design decision C), so it never needs rewriting.
      const now = new Date(Date.UTC(2026, 5, 7, 7, 7, 7, i))
      const dest = copyCorruptStateAside(path, now)
      expect(dest).not.toBeNull()
    }
    const after = countOpenFds()

    // A leaking close grows the open-fd count by ~1 per call (here, up to
    // `iterations`); a correct implementation grows it by ~0, modulo
    // unrelated test-runner noise. This threshold is intentionally far
    // below `iterations` so it cannot pass by accident.
    expect(after - before).toBeLessThan(iterations / 2)
  })
})

// ── finalizeAtomicWrite (finding 2, round 4 — the rename-fails-after-copy-succeeds path) ──

describe('finalizeAtomicWrite', () => {
  it("succeeds and leaves path holding the tmp file's content when the rename can actually happen", () => {
    const dir = tmpDir()
    const tmp = join(dir, 'real.tmp')
    const path = join(dir, 'test.state')
    writeFileSync(tmp, 'new content')
    expect(() => finalizeAtomicWrite(tmp, path, null)).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('new content')
  })

  it("throws a RecoveryWriteError carrying the already-preserved path when the final rename itself fails, leaving path untouched — the failure path this finding's own citation says was previously untested", () => {
    // A completely real ENOENT: `tmp` never existed. No mocking — measured
    // live (see this file's top comment) that forcing a real OS fault on a
    // same-directory rename between two regular files owned by root is not
    // achievable here, and vi.spyOn cannot redefine a node:fs named export
    // under this project's ESM/vitest setup — so this calls the exact
    // function `writeEntryWithRecovery` calls for its own final step,
    // directly, with the one input ANY caller of it (successful copy,
    // doomed rename) could actually produce.
    const dir = tmpDir()
    const tmp = join(dir, 'does-not-exist.tmp')
    const path = join(dir, 'test.state')
    writeFileSync(path, 'original untouched content')
    const quarantinedTo = join(dir, 'already-quarantined.corrupt')
    writeFileSync(quarantinedTo, 'the bytes preserved earlier')

    let thrown: unknown
    try {
      finalizeAtomicWrite(tmp, path, quarantinedTo)
      thrown = undefined
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect((thrown as RecoveryWriteError).quarantinedTo).toBe(quarantinedTo)
    expect((thrown as RecoveryWriteError).message).toContain(quarantinedTo)
    expect(readFileSync(path, 'utf8')).toBe('original untouched content')
  })

  it('throws a RecoveryWriteError with quarantinedTo null when nothing had needed preserving', () => {
    const dir = tmpDir()
    const tmp = join(dir, 'does-not-exist.tmp')
    const path = join(dir, 'test.state')
    writeFileSync(path, 'untouched')

    let thrown: unknown
    try {
      finalizeAtomicWrite(tmp, path, null)
      thrown = undefined
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect((thrown as RecoveryWriteError).quarantinedTo).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('untouched')
  })
})

// ── writeEntryWithRecovery (finding 4, round 2; 1, 2 round 4) ──────────

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

  it('malformed file: copies the corrupt bytes aside (preserved at quarantinedTo), new file starts clean with ONLY the new key, priorWasCorrupt true', () => {
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

  it('directory at the state path: copy-aside refuses it (finding 7) so this throws a RecoveryWriteError BEFORE the final rename — quarantinedTo null, directory left completely untouched (finding 2, round 4)', () => {
    const path = statePath()
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'inner.txt'), 'must not be touched')

    let thrown: unknown
    try {
      writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' })
      thrown = undefined
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect((thrown as RecoveryWriteError).quarantinedTo).toBeNull()
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(readFileSync(join(path, 'inner.txt'), 'utf8')).toBe('must not be touched')
  })
})
