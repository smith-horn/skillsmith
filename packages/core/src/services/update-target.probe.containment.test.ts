/**
 * @fileoverview The containment guard's ORDER, not its return value (SMI-6532 A2 §4.2).
 * @module @skillsmith/core/services/update-target.probe.containment.test
 *
 * WHY THIS FILE IS SEPARATE FROM `update-target.probe.test.ts`.
 *
 * It mocks `fs/promises` to record syscalls. That mock is per-module, so keeping it
 * here leaves the sibling suite on the real filesystem — where its realpath, retry and
 * permission cases belong, because a mocked `fs` would make those pass by construction.
 *
 * WHY THE SIBLING SUITE CANNOT PIN THIS.
 *
 * `probeUpdateTarget` refuses a write-set entry that escapes `dir`. Moving
 * `isContained` from ABOVE the `probeOneFile` call to BELOW it returns the IDENTICAL
 * value — `{ kind: 'unreadable', errno: 'EINVAL' }` — because the guard still runs and
 * still refuses. Only the I/O differs. So every assertion on the returned value passes
 * either way, and that relocation measurably survived all 27 tests in the sibling file.
 *
 * Measured, with a 512 MB regular file outside the root and an identical return value
 * from both:
 *
 *     guard above the read (correct)   1.1 ms      -- never opened it
 *     guard below the read (mutant)    16,525.2 ms -- read and SHA-256'd all of it
 *
 * So the order is load-bearing: under the mutant an attacker-named `../../../<path>`
 * in a write set is opened and fully buffered before being refused. The hash is
 * discarded, so this is not an exfiltration primitive by itself, but it is file access
 * outside the intended boundary and an unbounded read of a caller-named path.
 *
 * A first attempt to observe this used a FIFO canary and DISCRIMINATED NOTHING:
 * `probeOneFile` calls `lstat` first and bails on `!st.isFile()`, so a FIFO is never
 * opened in either order and both returned a fast EINVAL. Only regular files are ever
 * read. Hence the syscall recorder below, plus a positive control — an instrument that
 * returns the same answer for both states it exists to separate is measuring nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Hoisted so the `vi.mock` factory, which is lifted above every import, can close over it. */
const calls = vi.hoisted(() => ({ read: [] as string[], lstat: [] as string[] }))

// Finding 2 seam: lets a test make the Nth `lstat` call on a SPECIFIC path
// throw ENOENT while every other call (and every other path) forwards to the
// real filesystem untouched -- e.g. checkPresence's presence-check lstat on
// skillMdPath (call 1) succeeds normally, and probeOneFile's own later lstat
// on the identical path (call 2, inside the write-set loop) is the one made
// to vanish, reaching the fail-closed branch this seam exists to test.
const lstatEnoentAtCall = vi.hoisted(() => new Map<string, number>())
const lstatCallCounts = vi.hoisted(() => new Map<string, number>())

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: (p: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      calls.read.push(String(p))
      return (actual.readFile as (...a: unknown[]) => unknown)(p, ...rest)
    },
    lstat: (p: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      const key = String(p)
      calls.lstat.push(key)
      const count = (lstatCallCounts.get(key) ?? 0) + 1
      lstatCallCounts.set(key, count)
      if (lstatEnoentAtCall.get(key) === count) {
        const err = new Error(
          `ENOENT: no such file or directory, lstat '${key}'`
        ) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return (actual.lstat as (...a: unknown[]) => unknown)(p, ...rest)
    },
  }
})

const { probeUpdateTarget } = await import('./update-target.probe.js')

let root: string
let skillsDir: string
let dir: string
let canary: string

beforeEach(async () => {
  calls.read.length = 0
  calls.lstat.length = 0
  lstatEnoentAtCall.clear()
  lstatCallCounts.clear()
  root = await mkdtemp(join(tmpdir(), 'probe-contain-'))
  skillsDir = join(root, 'skills')
  dir = join(skillsDir, 'my-skill')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '# hi\n')
  // A regular file OUTSIDE `dir`. Regular, because only regular files are ever read.
  canary = join(skillsDir, 'canary.txt')
  await writeFile(canary, 'must never be read\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the containment guard runs BEFORE the read, not merely before the return', () => {
  it('positive control: an in-root write-set member IS read', async () => {
    // Without this, a recorder that never records anything would let the real
    // assertion below pass vacuously. This proves the instrument can see a read.
    await probeUpdateTarget({ dir, skillsDir, dirName: 'my-skill', writeSet: ['SKILL.md'] })
    expect(calls.read).toContain(join(dir, 'SKILL.md'))
  })

  it('never opens a write-set member that escapes the target dir', async () => {
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir,
      dirName: 'my-skill',
      writeSet: ['SKILL.md', '../canary.txt'],
    })

    // The refusal itself. True in BOTH orders, so it pins nothing on its own — it is
    // here so a failure of the real assertion is not mistaken for a broken fixture.
    expect(outcome).toEqual({
      kind: 'unreadable',
      error: { path: canary, errno: 'EINVAL' },
    })

    // The actual property. Fails if `isContained` is relocated below `probeOneFile`.
    expect(calls.read).not.toContain(canary)
  })

  it('does not even stat an escaping member', async () => {
    // Stronger and cheaper to satisfy: refusing before `probeOneFile` means zero
    // syscalls on the path, not just no read. Pins the guard above the whole call
    // rather than merely above the `readFile` inside it.
    await probeUpdateTarget({
      dir,
      skillsDir,
      dirName: 'my-skill',
      writeSet: ['SKILL.md', '../canary.txt'],
    })
    expect(calls.lstat).not.toContain(canary)
  })
})

describe('the absolute-path guard runs before path.join, not merely before the return (F3)', () => {
  // `path.join(dir, <absolute path>)` DISCARDS `dir` entirely
  // (`path.join('/a/b', '/etc/passwd')` -> `/a/b/etc/passwd`), so a mutant
  // that checks `path.isAbsolute` only AFTER joining -- or folds it into
  // `isContained` on the JOINED path instead of the raw entry -- would see a
  // path that (wrongly) looks contained and would stat/read it. This is not
  // a same-answer relocation like the `isContained`-vs-`probeOneFile` one
  // above: moving the absolute check past the join reintroduces the exact
  // F3 bug, so the syscall recorder below is what proves the guard runs on
  // the entry BEFORE it is ever joined onto `dir`.
  it('never stats or reads an absolute write-set member, at either its own path or the joined-onto-dir path', async () => {
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir,
      dirName: 'my-skill',
      writeSet: ['SKILL.md', canary],
    })

    expect(outcome).toEqual({
      kind: 'unreadable',
      error: { path: canary, errno: 'EINVAL' },
    })

    // What a join-then-check mutant would have looked at instead.
    const joinedButWrongPath = join(dir, canary)

    expect(calls.read).not.toContain(canary)
    expect(calls.read).not.toContain(joinedButWrongPath)
    expect(calls.lstat).not.toContain(canary)
    expect(calls.lstat).not.toContain(joinedButWrongPath)
  })
})

describe('Finding 2: the fail-closed branch — SKILL.md vanishes AFTER checkPresence already saw it present', () => {
  // `probeUpdateTarget`'s guard is `if (sha256 === null && entryType === undefined)`.
  // The `entryType !== undefined` arm (SKILL.md exists but isn't a regular
  // file) has coverage elsewhere; this arm — a genuine vanish between
  // checkPresence's presence-check lstat and probeOneFile's own later lstat
  // on the SAME path — had none. Deleting the whole `if` block survives all
  // other tests in this module (measured, SMI-6598 discipline): this is the
  // one that catches it.
  it('reports probe-failed, not a permissive ok, when SKILL.md is present at the presence check but gone by the write-set read', async () => {
    const skillMdPath = join(dir, 'SKILL.md')
    // Call 1: checkPresence's own `fs.lstat(skillMdPath)` — real, succeeds.
    // Call 2: probeOneFile's `fs.lstat(abs)` for the SAME path, inside the
    // write-set loop below — made to vanish.
    lstatEnoentAtCall.set(skillMdPath, 2)

    const outcome = await probeUpdateTarget({ dir, skillsDir, dirName: 'my-skill', writeSet: [] })

    expect(outcome).toEqual({
      kind: 'probe-failed',
      error: { path: skillMdPath, errno: 'ENOENT' },
    })
  })
})
