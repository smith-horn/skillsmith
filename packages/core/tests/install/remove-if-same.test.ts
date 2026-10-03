/**
 * SMI-6529 round 15: `removeIfSame` removes an entry only while it is still
 * the entry the caller saw. It checks the entry after parking it under a
 * random name, so a folder another program puts at the path in the meantime
 * is never the one deleted (Opus round 14, finding 2).
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RealFs = typeof import('node:fs/promises')

const PARKED = /\.skillsmith-removing-[0-9a-f]{32}$/

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'remove-if-same-'))
  vi.resetModules()
})

afterEach(async () => {
  vi.doUnmock('node:fs/promises')
  // SMI-6732 round 12: the park-name mechanism test stubs `node:crypto`, and
  // a stub that outlived its own case would hand every later case a constant
  // park name. Unmocking a module no case mocked is a no-op.
  vi.doUnmock('node:crypto')
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

async function load() {
  return await import('../../src/install/remove-if-same.js')
}

function eacces(p: PathLike): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, '${String(p)}'`), { code: 'EACCES' })
}

/** Act out another program putting its own folder at `target`, moving any entry there aside. */
async function swapIn(real: RealFs, target: string): Promise<void> {
  await real.rename(target, `${target}-moved`).catch(() => {})
  await real.mkdir(target)
  await real.writeFile(path.join(target, 'KEEP.md'), 'not ours', 'utf-8')
}

/** Mock one `node:fs/promises` function for the module loaded next. */
function mockFs<K extends 'rename' | 'lstat' | 'rm' | 'unlink' | 'readdir'>(
  name: K,
  make: (actual: RealFs) => RealFs[K]
): void {
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<RealFs>('node:fs/promises')
    const fn = make(actual)
    return { ...actual, default: { ...actual, [name]: fn }, [name]: fn }
  })
}

/**
 * The 32-hex suffix of the single parked entry `removeIfSame` left in `dir`
 * for `basename`, read from the filesystem itself.
 *
 * SMI-6732 round 12: the park-name tests take the name from the directory
 * rather than from a failure message, so they pin where the name actually
 * lands and cannot be broken by rewording that message. `parkedPattern` comes
 * from the module under test, so the match is the production definition of a
 * parked name and never a second copy of it that could drift.
 */
async function parkedSuffix(
  dir: string,
  basename: string,
  parkedPattern: (target: string) => RegExp
): Promise<string> {
  const pattern = parkedPattern(path.join(dir, basename))
  const hits = (await readdir(dir)).filter((entry) => pattern.test(entry))
  // Exactly one: zero means nothing was parked, more than one means this
  // reads a name some other case left behind.
  expect(hits).toHaveLength(1)
  return hits[0].slice(-32)
}

describe('removeIfSame (SMI-6529 round 15)', () => {
  it('removes a folder, a file and a symlink that are still what the caller saw', async () => {
    const { removeIfSame } = await load()
    const dir = path.join(root, 'dir')
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await writeFile(path.join(dir, 'sub', 'a.md'), 'a', 'utf-8')
    const file = path.join(root, 'file')
    await writeFile(file, 'f', 'utf-8')
    const pointedAt = path.join(root, 'pointed-at')
    await mkdir(pointedAt)
    const link = path.join(root, 'link')
    await symlink(pointedAt, link)

    for (const p of [dir, file, link]) {
      expect(await removeIfSame(p, await lstat(p))).toEqual({ removed: true })
    }
    // The symlink is gone; what it pointed at is not.
    expect(await readdir(root)).toEqual(['pointed-at'])
  })

  it('counts an entry that is already gone as removed', async () => {
    const { removeIfSame } = await load()
    const target = path.join(root, 'gone')
    await mkdir(target)
    const seen = await lstat(target)
    await rm(target, { recursive: true })
    expect(await removeIfSame(target, seen)).toEqual({ removed: true })
  })

  // Round 17: the identity is checked before the entry is parked, so an
  // ordinary mismatch moves nothing at all.
  it('refuses without moving anything when the entry was already replaced', async () => {
    const { removeIfSame } = await load()
    const target = path.join(root, 'skill')
    await mkdir(target)
    const seen = await lstat(target)
    await rename(target, `${target}-moved`)
    await mkdir(target)
    await writeFile(path.join(target, 'KEEP.md'), 'not ours', 'utf-8')

    expect(await removeIfSame(target, seen)).toEqual({
      removed: false,
      reason: 'was replaced by something else, so it was left in place',
    })
    expect(await readFile(path.join(target, 'KEEP.md'), 'utf-8')).toBe('not ours')
    expect((await readdir(root)).sort()).toEqual(['skill', 'skill-moved'])
    expect((await readdir(root)).some((n) => PARKED.test(n))).toBe(false)
  })

  it('never deletes a folder another program puts at the path while the delete runs', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs('rm', (actual) => {
      let swapped = false
      return (async (...args: Parameters<RealFs['rm']>) => {
        if (!swapped) {
          swapped = true
          await swapIn(actual, target)
        }
        return actual.rm(...args)
      }) as RealFs['rm']
    })
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, await lstat(target))).toEqual({ removed: true })
    expect(await readFile(path.join(target, 'KEEP.md'), 'utf-8')).toBe('not ours')
    expect(await readdir(root)).toEqual(['skill'])
  })

  it('leaves what is left parked when the delete fails, and names where', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs(
      'rm',
      () =>
        (async (p: PathLike) => {
          throw eacces(p)
        }) as RealFs['rm']
    )
    const { removeIfSame } = await load()

    // Round 17: nothing is renamed back, so the caller is told exactly where
    // what is left ended up. The next uninstall of this skill reports it too.
    const result = await removeIfSame(target, await lstat(target))
    expect(result.removed).toBe(false)
    const reason = result.removed ? '' : result.reason
    expect(reason).toMatch(/^could not be removed \(EACCES\); what is left of it is at /)
    const parked = reason.slice(reason.lastIndexOf(' ') + 1)
    expect(path.basename(parked)).toMatch(PARKED)
    expect(await readFile(path.join(parked, 'SKILL.md'), 'utf-8')).toBe('ours')
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // Round 16 (both reviewers), round 17 (cross-model): `rename` REPLACES what
  // is at the destination — a directory replaces an empty directory, a file
  // replaces a file or a symlink — so nothing is ever renamed back.
  it('leaves what it removed parked rather than replacing a folder that took the path', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs(
      'rm',
      (actual) =>
        (async (p: PathLike) => {
          // Another program takes the path, with an empty directory: exactly
          // what an unguarded put-back would replace.
          await actual.mkdir(target)
          throw eacces(p)
        }) as RealFs['rm']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, await lstat(target))
    expect(result.removed).toBe(false)
    const reason = result.removed ? '' : result.reason
    expect(reason).toMatch(/^could not be removed \(EACCES\); what is left of it is at /)
    // Their directory is untouched, and ours is still parked beside it.
    expect(await readdir(target)).toEqual([])
    const parked = (await readdir(root)).find((n) => PARKED.test(n))
    expect(parked).toBeDefined()
    expect(await readFile(path.join(root, parked ?? '', 'SKILL.md'), 'utf-8')).toBe('ours')
  })

  it('leaves a parked file rather than replacing a file that took the path', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    const seen = await lstat(target)
    mockFs(
      'lstat',
      (actual) =>
        (async (...args: Parameters<RealFs['lstat']>) => {
          if (PARKED.test(String(args[0]))) {
            // The check fails, and another program writes its own file there.
            await actual.writeFile(target, 'theirs', 'utf-8')
            throw eacces(args[0])
          }
          return actual.lstat(...args)
        }) as RealFs['lstat']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, seen)
    expect(result.removed).toBe(false)
    expect(result.removed ? '' : result.reason).toMatch(
      /^could not be checked \(EACCES\) and is now at /
    )
    expect(await readFile(target, 'utf-8')).toBe('theirs')
    const parked = (await readdir(root)).find((n) => PARKED.test(n))
    expect(parked).toBeDefined()
    expect(await readFile(path.join(root, parked ?? ''), 'utf-8')).toBe('ours')
  })

  it('leaves an entry it cannot move aside where it is', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    mockFs(
      'rename',
      (actual) =>
        (async (from: PathLike, to: PathLike) => {
          if (String(from) === target) throw eacces(from)
          return actual.rename(from, to)
        }) as RealFs['rename']
    )
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, await lstat(target))).toEqual({
      removed: false,
      reason: 'could not be moved aside to be removed (EACCES), so it was left in place',
    })
    expect((await lstat(target)).isDirectory()).toBe(true)
  })

  // Round 19 (Opus): a regular file can go back atomically — `link` fails
  // with EEXIST instead of replacing — so files are put back while
  // directories and symlinks stay parked.
  it('puts a parked file back when the path is free', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    mockFs(
      'unlink',
      () =>
        (async (p: PathLike) => {
          throw eacces(p)
        }) as RealFs['unlink']
    )
    const { removeIfSame } = await load()

    // Every unlink fails here, so the link under the parked name cannot be
    // cleaned up either — and the reason says so (round 20, cross-model review).
    const result = await removeIfSame(target, await lstat(target))
    expect(result.removed).toBe(false)
    expect(result.removed ? '' : result.reason).toMatch(
      /^could not be removed \(EACCES\), so it was left in place; a link to it also remains at /
    )
    expect(await readFile(target, 'utf-8')).toBe('ours')
  })

  it('cleans up the parked link when it puts a file back', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    mockFs('unlink', (actual) => {
      let first = true
      return (async (p: PathLike) => {
        // The delete fails; the cleanup of the parked link succeeds.
        if (first) {
          first = false
          throw eacces(p)
        }
        return actual.unlink(p)
      }) as RealFs['unlink']
    })
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, await lstat(target))).toEqual({
      removed: false,
      reason: 'could not be removed (EACCES), so it was left in place',
    })
    expect(await readFile(target, 'utf-8')).toBe('ours')
    expect(await readdir(root)).toEqual(['note.md'])
  })

  it('puts a file another program left at the path back, rather than parking it', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    const seen = await lstat(target)
    mockFs(
      'rename',
      (actual) =>
        (async (from: PathLike, to: PathLike) => {
          if (String(from) === target) {
            // Between the check and the park, another program replaces it.
            // Written elsewhere and renamed in, so it is a distinct inode: a
            // freed one can be reused straight away.
            const theirs = `${target}.theirs`
            await actual.writeFile(theirs, 'theirs', 'utf-8')
            await actual.rename(theirs, target)
          }
          return actual.rename(from, to)
        }) as RealFs['rename']
    )
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, seen)).toEqual({
      removed: false,
      reason: 'was replaced by something else, so it was left in place',
    })
    expect(await readFile(target, 'utf-8')).toBe('theirs')
    expect((await readdir(root)).some((n) => PARKED.test(n))).toBe(false)
  })

  // Round 21 (Opus): the pre-check already established this is our regular
  // file, so it goes back even when the parked entry cannot be checked.
  it('puts a file back when the parked entry cannot be checked', async () => {
    const target = path.join(root, 'note.md')
    await writeFile(target, 'ours', 'utf-8')
    const seen = await lstat(target)
    mockFs(
      'lstat',
      (actual) =>
        (async (...args: Parameters<RealFs['lstat']>) => {
          if (PARKED.test(String(args[0]))) throw eacces(args[0])
          return actual.lstat(...args)
        }) as RealFs['lstat']
    )
    const { removeIfSame } = await load()

    expect(await removeIfSame(target, seen)).toEqual({
      removed: false,
      reason: 'could not be checked (EACCES), so it was left in place',
    })
    expect(await readFile(target, 'utf-8')).toBe('ours')
    expect(await readdir(root)).toEqual(['note.md'])
  })

  // Round 25 (cross-model review): an empty list said "nothing is parked" when
  // the truth was "this folder could not be listed".
  it('says when it could not look for parked leftovers', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    mockFs(
      'readdir',
      (actual) =>
        (async (...args: Parameters<RealFs['readdir']>) => {
          if (String(args[0]) === root) throw eacces(args[0])
          return actual.readdir(...args)
        }) as RealFs['readdir']
    )
    const { listParkedLeftovers } = await load()

    const scan = await listParkedLeftovers(target)

    expect(scan.parked).toEqual([])
    expect(scan.unreadable).toContain('could not be listed (EACCES)')
  })

  it('leaves an entry it cannot check parked, and says where', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    const seen = await lstat(target)
    mockFs(
      'lstat',
      (actual) =>
        (async (...args: Parameters<RealFs['lstat']>) => {
          if (PARKED.test(String(args[0]))) throw eacces(args[0])
          return actual.lstat(...args)
        }) as RealFs['lstat']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, seen)
    expect(result.removed).toBe(false)
    expect(result.removed ? '' : result.reason).toMatch(
      /^could not be checked \(EACCES\) and is now at /
    )
    const left = await readdir(root)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatch(PARKED)
  })

  // SMI-6732 M1a: the park name's unpredictability -- not merely its shape --
  // is what makes the recursive delete un-raceable. A shape check
  // (`PARKED`, `[0-9a-f]{32}`) is satisfied by 32 literal zeroes just as well
  // as by real randomness, so it cannot tell `randomBytes(16)` apart from a
  // constant. Two removals of entries with the SAME basename can only differ
  // in their random suffix -- the tag and basename are identical -- so
  // comparing those two suffixes kills the constant mutant.
  //
  // WHAT THIS DOES NOT PROVE (round 12, cross-family review). Two draws
  // differing is NON-REPETITION, which is strictly weaker than
  // unpredictability: a counter, a timestamp, a pid or a hash of the path all
  // produce differing suffixes and all let an attacker predict the next park
  // destination and pre-create it. No finite black-box test can close that
  // gap -- any observed sequence is reproducible by a deterministic generator
  // tailored to it -- so the mechanism itself is pinned white-box by the next
  // test, and this one is kept for the constant mutant it does kill.
  it('parks two equivalent removals under two different random names', async () => {
    mockFs(
      'rm',
      () =>
        (async (p: PathLike) => {
          throw eacces(p)
        }) as RealFs['rm']
    )
    const { removeIfSame, parkedPattern } = await load()

    const groupA = path.join(root, 'group-a')
    const groupB = path.join(root, 'group-b')
    await mkdir(groupA)
    await mkdir(groupB)
    // Same basename in both groups: `parkedName` derives its non-random
    // portion from `path.basename(target)` + the fixed `PARK_TAG`, so an
    // identical basename isolates the random suffix as the only thing that
    // can differ between the two parked names below.
    const targetA = path.join(groupA, 'skill')
    const targetB = path.join(groupB, 'skill')
    await mkdir(targetA)
    await mkdir(targetB)

    const resultA = await removeIfSame(targetA, await lstat(targetA))
    const resultB = await removeIfSame(targetB, await lstat(targetB))

    expect(resultA.removed).toBe(false)
    expect(resultB.removed).toBe(false)
    // Read the two names off the filesystem rather than out of the failure
    // prose. An earlier version sliced them from `reason` at its last space,
    // which coupled a security test to a message's wording: rephrasing the
    // message, or adding a trailing period, would have broken it while the
    // behaviour under test stayed correct (round 12, cross-family review).
    const hexA = await parkedSuffix(groupA, 'skill', parkedPattern)
    const hexB = await parkedSuffix(groupB, 'skill', parkedPattern)
    // The property this test does pin: real randomness makes these differ.
    // A constant-hex mutant produces the SAME suffix both times.
    expect(hexA).not.toBe(hexB)
  })

  // SMI-6732 M1b: pins the MECHANISM the test above cannot reach. The park
  // name must come from a CSPRNG, because unpredictability -- not uniqueness
  // -- is what stops an attacker pre-creating the name the rename is about to
  // land on. Stubbing `node:crypto` and asserting the parked name carries
  // exactly the stubbed bytes kills every unique-but-predictable generator
  // (counter, timestamp, pid, path hash), none of which calls `randomBytes`.
  // Asserting the draw SIZE too keeps the entropy from being narrowed: a
  // `randomBytes(2)` mutant leaves only 65,536 guesses.
  it('derives the parked name from crypto.randomBytes, not from anything predictable', async () => {
    const draws: number[] = []
    const stub = Buffer.alloc(16, 0xab)
    vi.doMock('node:crypto', async () => {
      const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
      const randomBytes = (size: number): Buffer => {
        draws.push(size)
        return stub
      }
      return { ...actual, default: { ...actual, randomBytes }, randomBytes }
    })
    mockFs(
      'rm',
      () =>
        (async (p: PathLike) => {
          throw eacces(p)
        }) as RealFs['rm']
    )
    const { removeIfSame, parkedPattern } = await load()

    const target = path.join(root, 'skill')
    await mkdir(target)

    const result = await removeIfSame(target, await lstat(target))

    expect(result.removed).toBe(false)
    // Exactly one draw, of the full 16 bytes -- not zero (a predictable
    // generator), not a narrowed size.
    expect(draws).toEqual([16])
    expect(await parkedSuffix(root, 'skill', parkedPattern)).toBe(stub.toString('hex'))
  })

  // SMI-6732 M3: `force: true` on the final `fsp.rm(parked, ...)` call means
  // "tolerate the parked directory already being gone" -- the two only
  // differ when the parked path is absent at `rm` time. This constructs
  // that race for real: another actor deletes the parked directory (by
  // calling the REAL `rm` from inside this mock) in the instant before
  // `removeIfSame`'s own `fsp.rm(parked, {...})` call runs against it, so
  // that call always lands on an already-absent path. With the real
  // `force: true` that still reports success; a `force: false` mutant makes
  // that same call throw ENOENT, which `removeIfSame` cannot recover from
  // for a directory (only a regular file can be linked back).
  it('still reports success when the parked directory is removed by another actor an instant before its own rm call', async () => {
    const target = path.join(root, 'skill')
    await mkdir(target)
    await writeFile(path.join(target, 'SKILL.md'), 'ours', 'utf-8')
    mockFs(
      'rm',
      (actual) =>
        (async (...args: Parameters<RealFs['rm']>) => {
          // Another actor wins the race and removes the parked directory
          // first, using the REAL rm -- this always succeeds regardless of
          // the options `removeIfSame` itself will pass a moment later.
          await actual.rm(args[0], { recursive: true, force: true })
          // `removeIfSame`'s own call, now against an already-absent path.
          return actual.rm(...args)
        }) as RealFs['rm']
    )
    const { removeIfSame } = await load()

    const result = await removeIfSame(target, await lstat(target))

    expect(result).toEqual({ removed: true })
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
