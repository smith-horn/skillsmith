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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'

import { makeFixtureTempDir } from '../_lib/git-fixture-env.js'

import {
  QUARANTINE_DEST_MAX_ATTEMPTS,
  RECOVERY_WRITE_MAX_ATTEMPTS,
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

  it('never throws when the destination reservation fails for a reason other than EEXIST (ENAMETOOLONG)', () => {
    // Measured (not inferred, per CLAUDE.md's measure-don't-reason rule):
    // a path exceeding PATH_MAX makes openSync(dest, 'wx') throw
    // ENAMETOOLONG synchronously, independent of uid. The code no longer
    // calls lstat; the destination reservation (allocateQuarantineDest)
    // runs first and is where this fails, so this is a DIFFERENT failure
    // than the missing-path case above (the reservation succeeds there and
    // opening the source throws ENOENT) — both must collapse to the same
    // swallowed `null`, never a throw.
    const longPath = `${statePath()}-${'a'.repeat(5000)}`
    let result: string | null | undefined
    expect(() => {
      result = copyCorruptStateAside(longPath)
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('never throws on an Invalid Date clock — toISOString RangeError collapses to null, path untouched (SMI-6995 S3)', () => {
    // Expected failure if allocateQuarantineDest computes the name outside
    // its try: copyCorruptStateAside throws RangeError ("Invalid time
    // value") at the toISOString call, failing the not.toThrow below.
    const path = statePath()
    writeFileSync(path, 'corrupt{{{')
    let result: string | null | undefined
    expect(() => {
      result = copyCorruptStateAside(path, new Date(Number.NaN))
    }).not.toThrow()
    expect(result).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('corrupt{{{')
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

  // Skipped (not failed) where /proc/self/fd does not exist: the descriptor
  // count is a Linux-only measurement, so a non-Linux host has nothing to count.
  it.skipIf(!existsSync('/proc/self/fd'))(
    'does not leak a file descriptor per call — the reservation fd is closed from a finally, not a combined expression a mutation could drop silently (finding 6)',
    () => {
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

      // PR #3020 review finding 6: the old `< iterations / 2` bound let a
      // mutation leaking every third descriptor (~66 here) pass. Vitest runs
      // each test file in its own forked process and this loop is fully
      // synchronous, so nothing else can open a descriptor between the two
      // counts: a correct implementation's delta is exactly 0 (measured).
      // Asserting exactly 0 (measured stable across repeated runs) is what
      // makes a leak of even one call in 200 fail; a slack would hide it.
      expect(after - before).toBe(0)
    }
  )

  it('copies from the descriptor it validated, so swapping path to a symlink mid-copy cannot redirect what is preserved (PR #3020 finding 3)', () => {
    const dir = tmpDir()
    const path = join(dir, 'test.state')
    const secret = join(dir, 'secret.txt')
    writeFileSync(path, 'the corrupt bytes{{{')
    writeFileSync(secret, 'SECRET CONTENT — must never be copied')
    let swapped = 0

    const dest = copyCorruptStateAside(path, new Date('2026-08-08T08:08:08.000Z'), {
      afterSourceOpened: () => {
        // Atomically replace `path` with a symlink to `secret` — what a
        // racing process could do between a name-based check and a
        // name-based copy.
        const link = join(dir, 'swap-link')
        symlinkSync(secret, link)
        renameSync(link, path)
        swapped++
      },
    })

    expect(swapped).toBe(1) // the swap really happened at the seam
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(dest).not.toBeNull()
    expect(dest !== null && readFileSync(dest, 'utf8')).toBe('the corrupt bytes{{{')
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
    // PR #3020 finding 2: the temp file written before the refusal is gone.
    expect(tmpSiblings(path)).toEqual([])
  })

  it('removes its temp file when preserving a corrupt regular file fails (every quarantine slot taken), path untouched (PR #3020 finding 2)', () => {
    const path = statePath()
    writeFileSync(path, 'corrupt{{{')
    const now = new Date('2026-09-09T09:09:09.000Z')
    const base = derivedQuarantineBase(path, now)
    writeFileSync(base, 'occupied')
    for (let n = 2; n <= QUARANTINE_DEST_MAX_ATTEMPTS; n++)
      writeFileSync(`${base}-${n}`, 'occupied')

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' }, { now })
    )

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect((thrown as RecoveryWriteError).quarantinedTo).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('corrupt{{{')
    expect(tmpSiblings(path)).toEqual([])
  })

  it('surfaces an Invalid Date clock as RecoveryWriteError (not a raw RangeError) when the prior state is corrupt; path untouched, no temp file (SMI-6995 S3)', () => {
    // Expected failure if the toISOString call escapes: the thrown value is a
    // RangeError, so toBeInstanceOf(RecoveryWriteError) fails.
    const path = statePath()
    writeFileSync(path, 'corrupt{{{')

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(
        path,
        'key-a',
        { foo: 'bar' },
        { now: new Date(Number.NaN) }
      )
    )

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect((thrown as RecoveryWriteError).quarantinedTo).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('corrupt{{{')
    expect(tmpSiblings(path)).toEqual([])
  })

  it('two writes in one process use DIFFERENT temp pathnames (invariant H: per-attempt, not per-process)', () => {
    // Expected failure if the random suffix is replaced by a constant: both
    // captured names are identical, so the `not.toBe` below fails.
    const path = statePath()
    const names: string[] = []
    const hooks = { onTempCreated: (t: string) => names.push(t) }

    writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: '1' }, { testHooks: hooks })
    writeEntryWithRecovery<State, Entry>(path, 'key-b', { foo: '2' }, { testHooks: hooks })

    expect(names).toHaveLength(2)
    expect(names[0]).not.toBe(names[1])
    expect(tmpSiblings(path)).toEqual([])
  })

  it('a regular file at the OLD pid-only temp name is never unlinked or truncated, and the write succeeds (invariant H)', () => {
    // Expected failure if unlink-on-EEXIST is restored AND the name is
    // pid-only: the planted file would be deleted. With the per-attempt name
    // the planted file is never even a candidate, so this pins that no
    // code path touches it: its inode and bytes must be unchanged.
    const dir = tmpDir()
    const path = join(dir, 'test.state')
    const planted = `${path}.tmp.${process.pid}`
    writeFileSync(planted, 'ANOTHER LIVE WRITER partial bytes')
    const inoBefore = lstatSync(planted).ino

    const result = writeEntryWithRecovery<State, Entry>(path, 'key-a', { foo: 'bar' })

    expect(result.priorWasCorrupt).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'key-a': { foo: 'bar' } })
    expect(lstatSync(planted).ino).toBe(inoBefore)
    expect(readFileSync(planted, 'utf8')).toBe('ANOTHER LIVE WRITER partial bytes')
  })

  it('on EEXIST at a candidate temp name it draws a NEW name and never unlinks the existing file (invariant H)', () => {
    // Expected failure if unlink-on-EEXIST is restored: the planted file at
    // the first candidate is deleted, so existsSync / the content check fail.
    const dir = tmpDir()
    const path = join(dir, 'test.state')
    const planted = `${path}.tmp.${process.pid}.taken`
    writeFileSync(planted, 'IN-FLIGHT bytes of another writer')
    const inoBefore = lstatSync(planted).ino
    const suffixes = ['taken', 'fresh']
    const used: string[] = []

    writeEntryWithRecovery<State, Entry>(
      path,
      'key-a',
      { foo: 'bar' },
      {
        testHooks: {
          tempSuffix: () => suffixes.shift() ?? 'exhausted',
          onTempCreated: (t) => used.push(t),
        },
      }
    )

    expect(used).toEqual([`${path}.tmp.${process.pid}.fresh`])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'key-a': { foo: 'bar' } })
    expect(lstatSync(planted).ino).toBe(inoBefore)
    expect(readFileSync(planted, 'utf8')).toBe('IN-FLIGHT bytes of another writer')
  })

  it('never follows a symlink planted at a candidate temp name — the sentinel is untouched and the symlink itself is not unlinked (invariant H)', () => {
    // Expected failure if the temp file is opened with plain 'w': openSync
    // follows the symlink and truncates the sentinel. If unlink-on-EEXIST is
    // restored: the symlink is removed, so the lstat below throws.
    const dir = tmpDir()
    const path = join(dir, 'test.state')
    const sentinel = join(dir, 'sentinel.txt')
    writeFileSync(sentinel, 'SENTINEL — must never be truncated')
    const planted = `${path}.tmp.${process.pid}.taken`
    symlinkSync(sentinel, planted)
    const suffixes = ['taken']

    const result = writeEntryWithRecovery<State, Entry>(
      path,
      'key-a',
      { foo: 'bar' },
      { testHooks: { tempSuffix: () => suffixes.shift() ?? 'exhausted' } }
    )

    expect(result.priorWasCorrupt).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe('SENTINEL — must never be truncated')
    expect(lstatSync(planted).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'key-a': { foo: 'bar' } })
  })

  it('refuses, as RecoveryWriteError, when EVERY candidate temp name is taken — nothing is unlinked, path untouched (invariant H)', () => {
    // Expected failure if the bound is removed or unlink-on-EEXIST restored:
    // either the call does not throw, or the planted file disappears.
    const dir = tmpDir()
    const path = join(dir, 'test.state')
    writeFileSync(path, `${JSON.stringify({ orig: { foo: 'o' } })}\n`)
    const planted = `${path}.tmp.${process.pid}.same`
    mkdirSync(planted)
    writeFileSync(join(planted, 'inner.txt'), 'x')

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(
        path,
        'key-a',
        { foo: 'bar' },
        { testHooks: { tempSuffix: () => 'same' } }
      )
    )

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ orig: { foo: 'o' } })
    expect(lstatSync(planted).isDirectory()).toBe(true)
    expect(readFileSync(join(planted, 'inner.txt'), 'utf8')).toBe('x')
  })

  it('reports a temp file it could not remove on the thrown error instead of swallowing it (invariant F)', () => {
    // Expected failure if the cleanup catch swallows the failure again:
    // `tempLeft` is [] so the toEqual([tmp]) below fails.
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ orig: { foo: 'o' } })}\n`)
    let tmpName = ''

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(
        path,
        'key-a',
        { foo: 'bar' },
        {
          testHooks: {
            onTempCreated: (t) => {
              tmpName = t
            },
            // The rename fails (non-empty directory at `path`) ...
            afterCommitCheck: () => {
              rmSync(path)
              mkdirSync(path)
              writeFileSync(join(path, 'inner.txt'), 'x')
            },
            // ... and the cleanup unlink fails too: a real EISDIR/EPERM, because
            // a non-empty directory now stands at the temp name.
            beforeTempCleanup: (t) => {
              rmSync(t)
              mkdirSync(t)
              writeFileSync(join(t, 'inner.txt'), 'y')
            },
          },
        }
      )
    )

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect(tmpName).not.toBe('')
    expect((thrown as RecoveryWriteError).tempLeft).toEqual([tmpName])
    expect((thrown as RecoveryWriteError).message).toContain(tmpName)
    expect(lstatSync(tmpName).isDirectory()).toBe(true)
  })

  it('reports every temp file it could not remove across retried attempts, each under a distinct name (invariant F + H)', () => {
    // Expected failure if leftovers are not collected across the 'changed'
    // retry path: the final error carries fewer than RECOVERY_WRITE_MAX_ATTEMPTS
    // entries. If names repeat across attempts the Set size check fails.
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ orig: { foo: 'o' } })}\n`)
    let n = 0

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(
        path,
        'key-a',
        { foo: 'bar' },
        {
          testHooks: {
            // Another writer commits after the temp exists, so the pre-rename
            // identity check returns 'changed' on every attempt.
            onTempCreated: () => commitLikeAnotherWriter(path, { other: { foo: String(++n) } }),
            beforeTempCleanup: (t) => {
              rmSync(t)
              mkdirSync(t)
              writeFileSync(join(t, 'inner.txt'), 'y')
            },
          },
        }
      )
    )

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    const left = (thrown as RecoveryWriteError).tempLeft
    expect(left).toHaveLength(RECOVERY_WRITE_MAX_ATTEMPTS)
    expect(new Set(left).size).toBe(RECOVERY_WRITE_MAX_ATTEMPTS)
  })

  it('removes its temp file when the final rename fails inside a real call (PR #3020 finding 2)', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ orig: { foo: 'o' } })}\n`)
    let fired = 0

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(
        path,
        'key-a',
        { foo: 'bar' },
        {
          testHooks: {
            // After the identity check passed: a non-empty directory now
            // stands at `path`, so rename(tmp, path) fails with a real errno.
            afterCommitCheck: () => {
              fired++
              rmSync(path)
              mkdirSync(path)
              writeFileSync(join(path, 'inner.txt'), 'x')
            },
          },
        }
      )
    )

    expect(fired).toBe(1)
    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(tmpSiblings(path)).toEqual([])
  })
})

// ── writeEntryWithRecovery: concurrent writers (PR #3020 finding 1) ──────

/** Commits `state` at `path` the way the plain producers do: temp + rename. */
function commitLikeAnotherWriter(path: string, state: unknown): void {
  const tmp = `${path}.other-writer`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

function tmpSiblings(path: string): string[] {
  const dir = join(path, '..')
  const base = path.slice(dir.length + 1)
  return readdirSync(dir).filter((n) => n.startsWith(`${base}.tmp.`))
}

function corruptSiblings(path: string): string[] {
  const dir = join(path, '..')
  const base = path.slice(dir.length + 1)
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${base}.corrupt-`))
    .map((n) => join(dir, n))
}

function catchError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (err) {
    return err
  }
}

describe('writeEntryWithRecovery under a concurrent writer', () => {
  it('a valid state committed between the read and the rename survives: the write retries and merges into it', () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ orig: { foo: 'o' } })}\n`)
    const calls: number[] = []

    const result = writeEntryWithRecovery<State, Entry>(
      path,
      'key-a',
      { foo: 'bar' },
      {
        testHooks: {
          afterRead: (attempt) => {
            calls.push(attempt)
            if (attempt === 1) {
              commitLikeAnotherWriter(path, { orig: { foo: 'o' }, other: { foo: 'committed' } })
            }
          },
        },
      }
    )

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      orig: { foo: 'o' },
      other: { foo: 'committed' },
      'key-a': { foo: 'bar' },
    })
    expect(calls).toEqual([1, 2]) // the interleave fired, then exactly one retry
    expect(result).toEqual({ quarantinedTo: null, priorWasCorrupt: false })
    expect(tmpSiblings(path)).toEqual([])
  })

  it('a corrupt read followed by a concurrent VALID commit: the valid state is neither overwritten nor copied aside as corrupt', () => {
    const path = statePath()
    writeFileSync(path, 'not json{{{')
    const calls: number[] = []

    const result = writeEntryWithRecovery<State, Entry>(
      path,
      'key-a',
      { foo: 'bar' },
      {
        now: new Date('2026-10-10T10:10:10.000Z'),
        testHooks: {
          afterRead: (attempt) => {
            calls.push(attempt)
            if (attempt === 1) commitLikeAnotherWriter(path, { other: { foo: 'committed' } })
          },
        },
      }
    )

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      other: { foo: 'committed' },
      'key-a': { foo: 'bar' },
    })
    // Nothing was copied aside: the copy refused the descriptor whose
    // identity no longer matched the corrupt read, before writing any byte.
    expect(corruptSiblings(path)).toEqual([])
    expect(calls).toEqual([1, 2])
    expect(result).toEqual({ quarantinedTo: null, priorWasCorrupt: false })
  })

  it('an in-place rewrite (same inode) after the read is detected, and what gets preserved is the corrupt bytes actually overwritten', () => {
    const path = statePath()
    writeFileSync(path, 'first corrupt')
    const calls: number[] = []

    const result = writeEntryWithRecovery<State, Entry>(
      path,
      'key-a',
      { foo: 'bar' },
      {
        now: new Date('2026-11-11T11:11:11.000Z'),
        testHooks: {
          afterRead: (attempt) => {
            calls.push(attempt)
            if (attempt === 1) writeFileSync(path, 'second, longer corrupt payload')
          },
        },
      }
    )

    expect(calls).toEqual([1, 2])
    expect(result.priorWasCorrupt).toBe(true)
    expect(result.quarantinedTo !== null && readFileSync(result.quarantinedTo, 'utf8')).toBe(
      'second, longer corrupt payload'
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'key-a': { foo: 'bar' } })
  })

  it("gives up after RECOVERY_WRITE_MAX_ATTEMPTS without overwriting, leaving the other writer's last state and no temp file", () => {
    const path = statePath()
    writeFileSync(path, `${JSON.stringify({ n: 0 })}\n`)
    const calls: number[] = []

    const thrown = catchError(() =>
      writeEntryWithRecovery<State, Entry>(
        path,
        'key-a',
        { foo: 'bar' },
        {
          testHooks: {
            afterRead: (attempt) => {
              calls.push(attempt)
              commitLikeAnotherWriter(path, { n: attempt })
            },
          },
        }
      )
    )

    expect(thrown).toBeInstanceOf(RecoveryWriteError)
    expect((thrown as RecoveryWriteError).quarantinedTo).toBeNull()
    expect(calls).toHaveLength(RECOVERY_WRITE_MAX_ATTEMPTS)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: RECOVERY_WRITE_MAX_ATTEMPTS })
    expect(tmpSiblings(path)).toEqual([])
  })
})
